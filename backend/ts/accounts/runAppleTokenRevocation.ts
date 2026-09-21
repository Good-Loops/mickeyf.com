import { performance } from 'node:perf_hooks';
import mysql, { type Pool, type PoolConnection, type PoolOptions, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { loadAppleRevocationConfig, loadAppleRevocationLifecycle, type AppleRevocationConfig } from '../config/appleRevocationConfig';
import type { AppleTokenLifecycle } from '../config/appleTokenConfig';
import { verifyAppleTokenReadiness } from '../migrations/appleTokenSchema';
import { verifyAppleRevocationReadiness } from '../migrations/appleRevocationSchema';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { PRODUCTION_RUNTIME_DATABASE_ACCOUNT } from '../security/runtimeGrantManifest';
import { APPLE_TOKEN_PURGE_PREDICATE, createAppleTokenRevocationWorker } from './appleTokenRevocation';

export const APPLE_MAINTENANCE_MAX_DURATION_MS = 180_000;
export const APPLE_HTTP_MAINTENANCE_MAX_DURATION_MS = 90_000;
export const APPLE_MAINTENANCE_SHUTDOWN_MS = 5_000;
const PURGE_BATCH_SIZE = 100;
const PURGE_MAX_BATCHES = 100;
const QUERY_TIMEOUT_MS = 10_000;
const EXPIRED_GUARDS = 'expires_at <= UTC_TIMESTAMP(6)';
type CleanupBacklog = Readonly<{ tokenCleanupBacklog: boolean; guardCleanupBacklog: boolean }>;
type CleanupSummary = CleanupBacklog & Readonly<{
    expiredTokensPurged: number; guardsPurged: number; tokenCleanupBatches: number; guardCleanupBatches: number;
}>;
type RunDependencies = Readonly<{
    environment?: Readonly<Record<string, string | undefined>>;
    createPool?: (options: PoolOptions) => Pick<Pool, 'getConnection' | 'end'>;
    verifyConnection?: typeof verifyAppleRevocationConnection;
    loadLifecycle?: typeof loadAppleRevocationLifecycle;
    log?: (event: Record<string, unknown>) => void;
    maxDurationMs?: number;
    shutdownTimeoutMs?: number;
}>;

type MaintenanceOptions = Readonly<{
    database: Pick<Pool, 'getConnection'>;
    expectedServerUuid: string;
    loadLifecycle: () => AppleTokenLifecycle | Promise<AppleTokenLifecycle>;
    log?: (event: Record<string, unknown>) => void;
}>;
type ConnectionIdentity = Pick<AppleRevocationConfig, 'expectedAccount' | 'expectedServerUuid'>;
type MaintenanceExecution = Readonly<{
    durationMs: number;
    verifyConnection?: typeof verifyAppleRevocationConnection;
    acquired?: (connection: PoolConnection) => void;
}>;

class MaintenanceError extends Error {
    constructor(readonly reason: 'database' | 'deadline' | 'invalid-result') {
        super('Apple maintenance could not be confirmed.');
    }
}

/** Read-only gate on the exact connection the worker will borrow, never just environment assertions. */
export async function verifyAppleRevocationConnection(connection: PoolConnection, config: ConnectionIdentity): Promise<void> {
    const inspection: MigrationConnection = {
        query: (sql, values) => connection.query({ sql, timeout: 10_000 }, values),
    };
    try {
        const [rows] = await inspection.query(`SELECT DATABASE() AS databaseName,
            CURRENT_USER() AS currentUser, @@GLOBAL.server_uuid AS serverUuid`);
        const target = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined;
        if (!target || target.databaseName !== 'cms' || target.currentUser !== config.expectedAccount
            || target.serverUuid !== config.expectedServerUuid) throw new Error();
        await verifyAppleTokenReadiness(inspection);
        await verifyAppleRevocationReadiness(inspection);
    } catch {
        throw new Error('Apple revocation target identity or recorded schema could not be verified.');
    }
}

function destroyConnection(connection: PoolConnection): void {
    try { connection.destroy(); } catch { /* Still close a socket owned by an uncertain command. */ }
    try {
        (connection as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
    } catch { /* Never log driver teardown details. */ }
}

async function cleanupBacklog(connection: PoolConnection): Promise<CleanupBacklog> {
    const [rows] = await connection.query<RowDataPacket[]>({
        sql: `SELECT EXISTS(SELECT 1 FROM apple_provider_tokens WHERE ${APPLE_TOKEN_PURGE_PREDICATE} LIMIT 1) AS tokens,
            EXISTS(SELECT 1 FROM apple_auth_revocations WHERE ${EXPIRED_GUARDS} LIMIT 1) AS guards`,
        timeout: QUERY_TIMEOUT_MS,
    });
    if (!Array.isArray(rows) || rows.length !== 1 || ![0, 1].includes(rows[0].tokens) || ![0, 1].includes(rows[0].guards)) {
        throw new MaintenanceError('invalid-result');
    }
    return { tokenCleanupBacklog: rows[0].tokens === 1, guardCleanupBacklog: rows[0].guards === 1 };
}

/** Alternate tables so a large token queue cannot prevent guard cleanup within the same budget. */
async function cleanupExpiredMaterial(connection: PoolConnection): Promise<CleanupSummary> {
    const counts = { expiredTokensPurged: 0, guardsPurged: 0, tokenCleanupBatches: 0, guardCleanupBatches: 0 };
    let tokensDone = false;
    let guardsDone = false;
    await connection.query({ sql: 'SET SESSION autocommit = 1', timeout: QUERY_TIMEOUT_MS });
    async function purge(sql: string): Promise<number> {
        const [result] = await connection.query<ResultSetHeader>({ sql, timeout: QUERY_TIMEOUT_MS });
        if (!Number.isSafeInteger(result?.affectedRows) || result.affectedRows < 0 || result.affectedRows > PURGE_BATCH_SIZE) {
            throw new MaintenanceError('invalid-result');
        }
        return result.affectedRows;
    }
    for (let batch = 0; batch < PURGE_MAX_BATCHES && (!tokensDone || !guardsDone); batch++) {
        if (!tokensDone) {
            const deleted = await purge(`DELETE FROM apple_provider_tokens WHERE ${APPLE_TOKEN_PURGE_PREDICATE}
                ORDER BY retention_deadline, token_id LIMIT ${PURGE_BATCH_SIZE}`);
            counts.expiredTokensPurged += deleted;
            counts.tokenCleanupBatches++;
            tokensDone = deleted < PURGE_BATCH_SIZE;
        }
        if (!guardsDone) {
            const deleted = await purge(`DELETE FROM apple_auth_revocations WHERE ${EXPIRED_GUARDS}
                ORDER BY expires_at, subject_hash LIMIT ${PURGE_BATCH_SIZE}`);
            counts.guardsPurged += deleted;
            counts.guardCleanupBatches++;
            guardsDone = deleted < PURGE_BATCH_SIZE;
        }
    }
    return { ...counts, ...await cleanupBacklog(connection) };
}

function boundedDuration(value: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Invalid maintenance duration.');
    return value;
}

/** Owns one verified session, never the caller's pool or HTTP process. */
async function executeMaintenance(options: MaintenanceOptions, execution: MaintenanceExecution): Promise<number> {
    const started = performance.now();
    const log = options.log ?? ((event: Record<string, unknown>) => console.log(JSON.stringify(event)));
    let connection: PoolConnection | undefined;
    let stopped = false;
    let destroyed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanup: CleanupSummary | undefined;
    let exitCode = 1;
    let stage = 'configuration';
    const deadline = started + execution.durationMs;
    const emit = (event: Record<string, unknown>) => log({ component: 'apple-token-revocation',
        elapsedMs: Math.round(performance.now() - started), ...cleanup, ...event });
    const destroy = () => {
        if (connection && !destroyed) { destroyed = true; destroyConnection(connection); }
    };
    const assertRunning = () => {
        if (stopped || performance.now() >= deadline) {
            stopped = true;
            destroy();
            throw new MaintenanceError('deadline');
        }
    };
    try {
        if (options.expectedServerUuid.length !== 36
            || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(options.expectedServerUuid)) {
            throw new Error('Explicit Apple maintenance database identity is required.');
        }
        const runtime = PRODUCTION_RUNTIME_DATABASE_ACCOUNT;
        const identity = { expectedAccount: `${runtime.user}@${runtime.host}`, expectedServerUuid: options.expectedServerUuid };
        stage = 'database';
        const operation = async () => {
            const acquired = await options.database.getConnection();
            if (stopped) { destroyConnection(acquired); throw new MaintenanceError('deadline'); }
            connection = acquired;
            execution.acquired?.(acquired);
            assertRunning();
            // One verified session serves cleanup and retries. Only this owner releases it.
            const guarded = new Proxy(acquired, {
                get(target, property) {
                    if (property === 'release') return () => undefined;
                    if (property === 'destroy') return () => { stopped = true; destroy(); };
                    const value = Reflect.get(target, property);
                    if (property !== 'query') return typeof value === 'function' ? value.bind(target) : value;
                    return (...values: unknown[]) => {
                        assertRunning();
                        return Reflect.apply(value, target, values);
                    };
                },
            });
            await (execution.verifyConnection ?? verifyAppleRevocationConnection)(guarded, identity);
            cleanup = await cleanupExpiredMaterial(guarded);
            assertRunning();
            stage = 'lifecycle';
            const lifecycle = await options.loadLifecycle();
            assertRunning();
            stage = 'revocation';
            const worker = createAppleTokenRevocationWorker({
                clientId: lifecycle.clientId,
                vault: { decrypt(row) { assertRunning(); return lifecycle.repository.decrypt(row); } },
                appleTokens: { async revoke(token) { assertRunning(); await lifecycle.client.revoke(token); } },
                database: { async getConnection() { assertRunning(); return guarded; } },
            });
            const result = await worker.drain();
            // Network waits can expire more material after the initial cleanup probe.
            cleanup = { ...cleanup, ...await cleanupBacklog(guarded) };
            return { ...result, expired: result.expired + cleanup.expiredTokensPurged };
        };
        const result = await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                stopped = true;
                destroy();
                reject(new MaintenanceError('deadline'));
            }, Math.max(1, deadline - performance.now()));
        })]);
        const incomplete = result.status !== 'completed' || result.retried > 0 || result.expired > 0
            || cleanup!.guardCleanupBacklog || cleanup!.tokenCleanupBacklog;
        exitCode = incomplete ? 2 : 0;
        emit({ severity: incomplete ? 'ERROR' : 'INFO', ...result });
    } catch (error) {
        stopped = true;
        destroy();
        emit({ severity: 'ERROR', status: 'failed', reason: error instanceof MaintenanceError ? error.reason : stage });
    } finally {
        stopped = true;
        if (timer) clearTimeout(timer);
        if (connection && !destroyed) {
            try { connection.release(); }
            catch { destroy(); exitCode = 1; emit({ severity: 'ERROR', status: 'failed', reason: 'shutdown' }); }
        }
    }
    return exitCode;
}

/** Authenticated HTTP maintenance borrows one session and cannot end the website's shared pool. */
export function runAppleMaintenance(options: MaintenanceOptions,
    { maxDurationMs = APPLE_HTTP_MAINTENANCE_MAX_DURATION_MS }: { maxDurationMs?: number } = {}): Promise<number> {
    const durationMs = boundedDuration(maxDurationMs, APPLE_HTTP_MAINTENANCE_MAX_DURATION_MS);
    return executeMaintenance(options, { durationMs });
}

/** The dedicated entrypoint owns its pool and must exit after bounded shutdown. Importing starts no work. */
export async function runAppleTokenRevocation(args: readonly string[], dependencies: RunDependencies = {}): Promise<number> {
    const started = performance.now();
    const env = dependencies.environment ?? process.env;
    const log = dependencies.log ?? ((event: Record<string, unknown>) => console.log(JSON.stringify(event)));
    let pool: Pick<Pool, 'getConnection' | 'end'> | undefined;
    let connection: PoolConnection | undefined;
    let exitCode = 1;
    let shutdownMs = APPLE_MAINTENANCE_SHUTDOWN_MS;
    const emitFailure = (reason: string) => log({ component: 'apple-token-revocation',
        elapsedMs: Math.round(performance.now() - started), severity: 'ERROR', status: 'failed', reason });
    try {
        const durationMs = boundedDuration(dependencies.maxDurationMs ?? APPLE_MAINTENANCE_MAX_DURATION_MS,
            APPLE_MAINTENANCE_MAX_DURATION_MS);
        shutdownMs = boundedDuration(dependencies.shutdownTimeoutMs ?? APPLE_MAINTENANCE_SHUTDOWN_MS,
            APPLE_MAINTENANCE_SHUTDOWN_MS);
        const config = loadAppleRevocationConfig(args, env);
        pool = (dependencies.createPool ?? mysql.createPool)(config.databaseOptions);
        exitCode = await executeMaintenance({ database: pool, expectedServerUuid: config.expectedServerUuid,
            loadLifecycle: () => (dependencies.loadLifecycle ?? loadAppleRevocationLifecycle)(env), log },
        { durationMs, verifyConnection: dependencies.verifyConnection, acquired: value => { connection = value; } });
    } catch {
        emitFailure('configuration');
    } finally {
        if (pool) {
            let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([pool.end(), new Promise<never>((_resolve, reject) => {
                    shutdownTimer = setTimeout(() => reject(new Error('shutdown')), shutdownMs);
                })]);
            } catch {
                if (connection) destroyConnection(connection);
                exitCode = 1;
                emitFailure('shutdown');
            } finally { if (shutdownTimer) clearTimeout(shutdownTimer); }
        }
    }
    return exitCode;
}

if (require.main === module) {
    void runAppleTokenRevocation(process.argv.slice(2)).then(code => process.exit(code), () => process.exit(1));
}
