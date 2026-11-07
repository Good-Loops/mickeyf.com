import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MigrationConnection } from './leaderboardSchema';
import { migrationLockName } from './migrationRunner';
import { loadMigrationManifest } from './migrationManifest';
import { runtimeGrantLockName } from '../security/runtimeGrantOperations';
import { PRODUCTION_RUNTIME_DATABASE_ACCOUNT } from '../security/runtimeGrantManifest';
import { observeChildSignedFormMetadata, createChildSignedFormSchemaReceipt,
    type ChildSignedFormMetadataSettings, type ChildSignedFormMetadataSnapshot,
    type ChildSignedFormSchemaReceipt, type ChildSignedFormSource, type ChildSignedFormTarget } from './childSignedFormMetadata';

// This operation is intentionally outside the historical 0001–0026 manifest.
export const CHILD_SIGNED_FORM_SQL = `ALTER TABLE parent_signed_forms
    MODIFY COLUMN user_name VARCHAR(64) NULL,
    DROP CHECK chk_signed_form_status,
    ADD CONSTRAINT chk_signed_form_status CHECK (
        country_code IN ('US','BR') AND public_approved IN (0,1) AND public_withdrawn IN (0,1)
        AND (public_approved = 0 OR public_policy_digest IS NOT NULL)
        AND ((status = 'pending' AND reviewed_at IS NULL AND reviewer IS NULL AND form_sha256 IS NULL AND child_uuid IS NULL AND public_approved = 0)
          OR (status IN ('approved','rejected') AND reviewed_at IS NOT NULL AND reviewer IS NOT NULL AND form_sha256 IS NOT NULL AND child_uuid IS NULL)
          OR (status = 'used' AND reviewed_at IS NOT NULL AND reviewer IS NOT NULL AND form_sha256 IS NOT NULL AND child_uuid IS NOT NULL))
    );
`;
export const CHILD_SIGNED_FORM_SQL_SHA256 = '8dddfdda37f24f9842d5ed43b950412ab7218260a3c5a49d01eff9564a951cf8';
export const CHILD_SIGNED_FORM_PLAN_TTL_MS = 300_000;
type JsonObject = Record<string, unknown>;
export type ChildReleaseSafety = Readonly<{
    schemaVersion: 1; operation: 'child-schema-prerequisites'; observedAt: string;
    sourceCommit: string; sqlSha256: string; target: ChildSignedFormTarget;
    pinsSha256: string; serviceSha256: string; candidateSha256: string; fallbackSha256: string;
    readerSince: string; readerVerifiedAt: string; readerDurationMs: number;
    automationSha256: string; backup: Readonly<{ id: string; endTime: string; sha256: string }>;
    pitr: Readonly<{ earliestRecoveryTime: string; latestRecoveryTime: string }>;
    cloudSqlSha256: string; stableSha256: string;
}>;
type Baseline = Readonly<Pick<ChildSignedFormMetadataSnapshot,
    'identity' | 'history' | 'capability' | 'schemaSha256' | 'grantsSha256'>>;
export type ChildSignedFormPlan = Readonly<{
    schemaVersion: 1; operation: 'extend-child-signed-form-schema'; createdAt: string;
    sourceCommit: string; sqlSha256: string; target: ChildSignedFormTarget;
    baseline: Baseline; releaseSafety: ChildReleaseSafety; sha256: string;
}>;
export type ChildSignedFormOperationDependencies = Readonly<{
    connection: MigrationConnection; settings: ChildSignedFormMetadataSettings; source: ChildSignedFormSource;
    observeReleaseSafety: (approvedPlan?: ChildSignedFormPlan) => Promise<ChildReleaseSafety>;
    observeMetadata?: typeof observeChildSignedFormMetadata;
    assertSource?: () => void;
    now?: () => number; operationTimeoutMs?: number; advisoryLockTimeoutSeconds?: number; lockWaitTimeoutSeconds?: number;
}>;

export class ChildSignedFormOperationError extends Error {
    constructor(public readonly code: 'CHILD_SCHEMA_BLOCKED' | 'CHILD_SCHEMA_INDETERMINATE') {
        super(code === 'CHILD_SCHEMA_INDETERMINATE'
            ? 'Child schema outcome is indeterminate; do not retry. Reconnect and verify the exact target before reviewing recovery.'
            : 'Child schema operation blocked; refresh the exact source, target, metadata and reviewed release prerequisites.');
        this.name = 'ChildSignedFormOperationError';
    }
}
function blocked(): never { throw new ChildSignedFormOperationError('CHILD_SCHEMA_BLOCKED'); }
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
        `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`).join(',')}}`;
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
    return blocked();
}
export function childSignedFormFingerprint(value: unknown): string {
    return createHash('sha256').update(canonical(value)).digest('hex');
}
function exactKeys(value: unknown, keys: readonly string[]): asserts value is JsonObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) blocked();
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function instant(value: unknown): number {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return blocked();
    return Date.parse(value);
}
function fresh(value: string, now: number, age = 30_000) {
    const time = instant(value);
    if (time > now + 5_000 || now - time > age) blocked();
}
function same(left: unknown, right: unknown) { if (canonical(left) !== canonical(right)) blocked(); }
export function assertChildSignedFormSql(bytes: Buffer): void {
    if (!bytes.equals(Buffer.from(CHILD_SIGNED_FORM_SQL, 'utf8'))
        || createHash('sha256').update(bytes).digest('hex') !== CHILD_SIGNED_FORM_SQL_SHA256) blocked();
}
function source(deps: ChildSignedFormOperationDependencies) {
    deps.assertSource?.();
    assertChildSignedFormSql(readFileSync(path.resolve(__dirname, '../../migrations/pending/0028_extend_child_signed_parent_forms.sql')));
    if (!/^[a-f0-9]{40}$/u.test(deps.source.sourceCommit) || deps.source.sqlSha256 !== CHILD_SIGNED_FORM_SQL_SHA256) blocked();
}
function baseline(snapshot: ChildSignedFormMetadataSnapshot): Baseline {
    return { identity: snapshot.identity, history: snapshot.history, capability: snapshot.capability,
        schemaSha256: snapshot.schemaSha256, grantsSha256: snapshot.grantsSha256 };
}
async function metadata(deps: ChildSignedFormOperationDependencies, connection = deps.connection) {
    const snapshot = await (deps.observeMetadata ?? observeChildSignedFormMetadata)(connection, deps.settings);
    fresh(snapshot.observedAt, (deps.now ?? Date.now)());
    same(snapshot.target, deps.settings.target);
    same(snapshot.identity, { databaseName: deps.settings.target.database, currentUser: deps.settings.expectedCurrentUser,
        serverUuid: deps.settings.target.serverUuid, serverVersion: deps.settings.expectedServerVersion,
        versionComment: deps.settings.expectedVersionComment });
    const manifest = loadMigrationManifest();
    if (manifest.length !== 26 || !hash(snapshot.schemaSha256) || !hash(snapshot.grantsSha256)) blocked();
    same(snapshot.history, manifest.map(migration => ({ version: migration.version, checksumSha256: migration.checksum.toString('hex') })));
    return snapshot;
}
export function assertChildReleaseSafety(proof: ChildReleaseSafety, deps: Pick<ChildSignedFormOperationDependencies, 'settings' | 'source'>,
    now: number, approved?: ChildReleaseSafety): void {
    exactKeys(proof, ['schemaVersion', 'operation', 'observedAt', 'sourceCommit', 'sqlSha256', 'target', 'pinsSha256', 'serviceSha256',
        'candidateSha256', 'fallbackSha256', 'readerSince', 'readerVerifiedAt', 'readerDurationMs', 'automationSha256', 'backup', 'pitr', 'cloudSqlSha256', 'stableSha256']);
    exactKeys(proof.backup, ['id', 'endTime', 'sha256']);
    exactKeys(proof.pitr, ['earliestRecoveryTime', 'latestRecoveryTime']);
    if (proof.schemaVersion !== 1 || proof.operation !== 'child-schema-prerequisites') blocked();
    const { stableSha256, observedAt: _time, pitr: _window, ...stableBody } = proof;
    if (childSignedFormFingerprint(stableBody) !== stableSha256) blocked();
    same(proof.target, deps.settings.target);
    if (proof.sourceCommit !== deps.source.sourceCommit || proof.sqlSha256 !== deps.source.sqlSha256) blocked();
    for (const value of [proof.pinsSha256, proof.serviceSha256, proof.candidateSha256, proof.fallbackSha256,
        proof.automationSha256, proof.backup.sha256, proof.cloudSqlSha256, proof.stableSha256]) if (!hash(value)) blocked();
    fresh(proof.observedAt, now);
    const start = instant(proof.readerSince), end = instant(proof.readerVerifiedAt);
    if (!Number.isSafeInteger(proof.readerDurationMs) || proof.readerDurationMs < 300_000
        || end - start < 300_000 || end > instant(proof.observedAt) || start > now) blocked();
    const backup = instant(proof.backup.endTime), earliest = instant(proof.pitr.earliestRecoveryTime), latest = instant(proof.pitr.latestRecoveryTime);
    if (typeof proof.backup.id !== 'string' || !/^[0-9]{1,30}$/u.test(proof.backup.id)
        || backup > now + 5_000 || now - backup > 7_200_000 || earliest > latest
        || latest > now + 5_000 || now - latest > 900_000 || earliest > end) blocked();
    if (approved) {
        const { observedAt: _observed, pitr: _pitr, ...stable } = proof;
        const { observedAt: _priorObserved, pitr: _priorPitr, ...prior } = approved;
        same(stable, prior);
        const checkpoint = instant(approved.pitr.latestRecoveryTime);
        if (earliest > checkpoint || latest < checkpoint) blocked();
    }
}
function assertPlan(plan: ChildSignedFormPlan, deps: ChildSignedFormOperationDependencies, approvedSha256: string) {
    exactKeys(plan, ['schemaVersion', 'operation', 'createdAt', 'sourceCommit', 'sqlSha256', 'target', 'baseline', 'releaseSafety', 'sha256']);
    const { sha256, ...body } = plan;
    if (!hash(approvedSha256) || sha256 !== approvedSha256 || childSignedFormFingerprint(body) !== sha256
        || plan.schemaVersion !== 1 || plan.operation !== 'extend-child-signed-form-schema') blocked();
    fresh(plan.createdAt, (deps.now ?? Date.now)(), CHILD_SIGNED_FORM_PLAN_TTL_MS);
    if (instant(plan.createdAt) < instant(plan.releaseSafety.observedAt)) blocked();
    same(plan.target, deps.settings.target);
    same({ sourceCommit: plan.sourceCommit, sqlSha256: plan.sqlSha256 }, deps.source);
    // The authenticated reader rechecks this entire approved proof, never a caller-supplied timestamp alone.
    assertChildReleaseSafety(plan.releaseSafety, deps, instant(plan.createdAt));
}
export async function planChildSignedFormOperation(deps: ChildSignedFormOperationDependencies): Promise<ChildSignedFormPlan> {
    try {
        source(deps);
        const releaseSafety = await deps.observeReleaseSafety(); // The five-minute watch owns no SQL lock/transaction.
        assertChildReleaseSafety(releaseSafety, deps, (deps.now ?? Date.now)());
        const snapshot = await metadata(deps);
        if (snapshot.capability !== 'legacy-us') blocked();
        source(deps);
        assertChildReleaseSafety(releaseSafety, deps, (deps.now ?? Date.now)());
        const createdAt = new Date((deps.now ?? Date.now)()).toISOString();
        const body = { schemaVersion: 1 as const, operation: 'extend-child-signed-form-schema' as const, createdAt,
            ...deps.source, target: deps.settings.target, baseline: baseline(snapshot), releaseSafety };
        return { ...body, sha256: childSignedFormFingerprint(body) };
    } catch { return blocked(); }
}

export async function applyChildSignedFormOperation(deps: ChildSignedFormOperationDependencies, plan: ChildSignedFormPlan,
    approval: Readonly<{ approvedPlanSha256: string; confirmedServerUuid: string; allowApply: boolean }>): Promise<ChildSignedFormSchemaReceipt> {
    let discarded = false, ddlStarted = false;
    const acquiredLocks: string[] = [];
    const discard = () => { discarded = true; try { deps.connection.destroy?.(); } catch { /* Preserve the sanitized outcome. */ } };
    const timeout = deps.operationTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 120_000) blocked();
    const lockTimeout = deps.advisoryLockTimeoutSeconds ?? 5, lockWait = deps.lockWaitTimeoutSeconds ?? 10;
    if (!Number.isSafeInteger(lockTimeout) || lockTimeout < 0 || lockTimeout > 30
        || !Number.isSafeInteger(lockWait) || lockWait < 1 || lockWait > 60) blocked();
    let deadlineAt = Infinity, monotonicDeadline = Infinity;
    const connection: MigrationConnection = { async query(sql, values) {
        if (discarded || (deps.now ?? Date.now)() >= deadlineAt || performance.now() >= monotonicDeadline) { discard(); blocked(); }
        return deps.connection.query(sql, values);
    }, destroy: discard };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        source(deps); assertPlan(plan, deps, approval.approvedPlanSha256);
        if (approval.allowApply !== true || approval.confirmedServerUuid !== deps.settings.target.serverUuid) blocked();
        const initialSafety = await deps.observeReleaseSafety(plan);
        assertChildReleaseSafety(initialSafety, deps, (deps.now ?? Date.now)(), plan.releaseSafety);
        deadlineAt = (deps.now ?? Date.now)() + timeout;
        monotonicDeadline = performance.now() + timeout;
        const operation = async () => {
            await connection.query('SET SESSION autocommit = 1');
            await connection.query("SET SESSION time_zone = '+00:00'");
            await connection.query('SET SESSION lock_wait_timeout = ?', [lockWait]);
            // Grant maintenance takes only its own lock; no existing operation takes these in reverse order.
            for (const name of [migrationLockName(deps.settings.target.database),
                runtimeGrantLockName(deps.settings.target.database, PRODUCTION_RUNTIME_DATABASE_ACCOUNT)]) {
                const [rows] = await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [name, lockTimeout]);
                if (!Array.isArray(rows) || rows.length !== 1 || Number(rows[0].acquired) !== 1) blocked();
                acquiredLocks.push(name);
            }
            const snapshot = await metadata(deps, connection);
            same(baseline(snapshot), plan.baseline);
            if (snapshot.capability !== 'legacy-us') blocked();
            const liveSafety = await deps.observeReleaseSafety(plan);
            assertChildReleaseSafety(liveSafety, deps, (deps.now ?? Date.now)(), plan.releaseSafety);
            source(deps); assertPlan(plan, deps, approval.approvedPlanSha256);
            if (discarded || (deps.now ?? Date.now)() >= deadlineAt || performance.now() >= monotonicDeadline) { discard(); blocked(); }
            ddlStarted = true;
            await connection.query(CHILD_SIGNED_FORM_SQL);
            const after = await metadata(deps, connection);
            if (after.capability !== 'nullable-parent-request-us-br') blocked();
            same(after.grantsSha256, snapshot.grantsSha256);
            same(after.history, snapshot.history);
            same(after.identity, snapshot.identity);
            source(deps);
            return createChildSignedFormSchemaReceipt(after, deps.source);
        };
        return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { discard(); reject(new ChildSignedFormOperationError(
                ddlStarted ? 'CHILD_SCHEMA_INDETERMINATE' : 'CHILD_SCHEMA_BLOCKED')); }, timeout);
        })]);
    } catch {
        if (ddlStarted) { discard(); throw new ChildSignedFormOperationError('CHILD_SCHEMA_INDETERMINATE'); }
        return blocked();
    } finally {
        if (timer) clearTimeout(timer);
        if (acquiredLocks.length && !discarded) {
            let releaseTimer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([ (async () => {
                    for (const name of [...acquiredLocks].reverse()) {
                        const [rows] = await connection.query('SELECT RELEASE_LOCK(?) AS released', [name]);
                        if (!Array.isArray(rows) || rows.length !== 1 || Number(rows[0].released) !== 1) throw new Error();
                    }
                })(), new Promise<never>((_resolve, reject) => {
                    releaseTimer = setTimeout(() => { discard(); reject(new Error()); }, Math.min(timeout, 5_000));
                })]);
            } catch { discard(); throw new ChildSignedFormOperationError(ddlStarted ? 'CHILD_SCHEMA_INDETERMINATE' : 'CHILD_SCHEMA_BLOCKED'); }
            finally { if (releaseTimer) clearTimeout(releaseTimer); }
        }
    }
}

export async function verifyChildSignedFormOperation(deps: ChildSignedFormOperationDependencies): Promise<ChildSignedFormSchemaReceipt> {
    try { source(deps); const snapshot = await metadata(deps); source(deps); return createChildSignedFormSchemaReceipt(snapshot, deps.source); }
    catch { return blocked(); }
}
