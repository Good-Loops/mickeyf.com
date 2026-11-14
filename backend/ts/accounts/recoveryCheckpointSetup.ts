import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from './deletionJournal';
import { verifyRecoveryCheckpointSchema } from './recoveryCheckpointSchema';
import type { ObservedRestoreGuard } from './gcsRetentionJournal';
import { migrationLockName } from '../migrations/migrationRunner';
import { runtimeGrantLockName } from '../security/runtimeGrantOperations';
import { PRODUCTION_RUNTIME_DATABASE_ACCOUNT } from '../security/runtimeGrantManifest';

type Connection = Pick<PoolConnection, 'query' | 'destroy'>;
type Pins = Readonly<{ database: string; currentUser: string; serverUuid: string }>;
type Dependencies = Readonly<{ connection: Connection; pins: Pins; sourceCommit: string;
    guard: Readonly<{ readRestoreGuard(): Promise<ObservedRestoreGuard>; assertRestoreGuardHistory(): Promise<void> }>;
    verifySource(): void; verifyAccountSchema(connection: Connection): Promise<void>;
    verifyRecoveryAvailable(): Promise<void>; verifyWritersFenced(connection: Connection): Promise<void>;
    now?: () => number }>;
type PlanBody = Readonly<{ version: 1; database: string; currentUser: string; serverUuid: string; guardGeneration: string;
    lineage: string; sourceCommit: string; createdAt: string }>;
export type RecoveryCheckpointSetupPlan = PlanBody & Readonly<{ sha256: string }>;
const SQL_SHA256 = '52e5698e21680113869d245808e782dbbdbcd84d356ca31a1c3367f9402e7108';
const FAILURE = 'Checkpoint setup blocked or unconfirmed. Keep recovery held and inspect before retrying.';

function sql(): string {
    const bytes = readFileSync(path.resolve(__dirname, '../../migrations/pending/draft_account_recovery_checkpoint.sql'));
    if (createHash('sha256').update(bytes).digest('hex') !== SQL_SHA256) throw new Error(FAILURE);
    return bytes.toString('utf8');
}
function digest(body: PlanBody): string { return createHash('sha256').update(JSON.stringify(body)).digest('hex'); }
async function state(deps: Dependencies): Promise<ObservedRestoreGuard> {
    deps.verifySource(); sql();
    const [identity] = await deps.connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS db,CURRENT_USER() AS user,
        @@GLOBAL.server_uuid AS uuid`, timeout: 10_000 });
    if (!Array.isArray(identity) || identity.length !== 1 || identity[0].db !== deps.pins.database
        || identity[0].user !== deps.pins.currentUser || identity[0].uuid !== deps.pins.serverUuid) throw new Error();
    await deps.guard.assertRestoreGuardHistory();
    const guard = await deps.guard.readRestoreGuard();
    if (guard.state !== 'hold' || guard.database !== deps.pins.database || guard.serverUuid !== deps.pins.serverUuid
        || guard.recoveryCheckpoint !== undefined) throw new Error();
    await deps.verifyAccountSchema(deps.connection);
    await deps.verifyWritersFenced(deps.connection);
    await deps.verifyRecoveryAvailable();
    const [tables] = await deps.connection.query<RowDataPacket[]>({ sql: `SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='account_recovery_checkpoint'`, timeout: 10_000 });
    if (!Array.isArray(tables) || tables.length !== 0 || JSON.stringify(await deps.guard.readRestoreGuard()) !== JSON.stringify(guard)) throw new Error();
    return guard;
}

export async function planRecoveryCheckpointSetup(deps: Dependencies): Promise<RecoveryCheckpointSetupPlan> {
    try {
        if (!/^[a-f0-9]{40}$/u.test(deps.sourceCommit)) throw new Error();
        const guard = await state(deps);
        const body: PlanBody = { version: 1, ...deps.pins, guardGeneration: guard.generation, lineage: randomUUID(),
            sourceCommit: deps.sourceCommit, createdAt: new Date((deps.now ?? Date.now)()).toISOString() };
        return { ...body, sha256: digest(body) };
    } catch { throw new Error(FAILURE); }
}

/** DDL can commit even when its response is lost; an uncertain apply is never retried automatically. */
export async function applyRecoveryCheckpointSetup(deps: Dependencies, plan: RecoveryCheckpointSetupPlan,
    confirmation: Readonly<{ sha256: string; writers: string }>): Promise<void> {
    const locks: string[] = []; let ddlStarted = false, completed = false;
    try {
        if (!plan || Object.keys(plan).sort().join(',') !== 'createdAt,currentUser,database,guardGeneration,lineage,serverUuid,sha256,sourceCommit,version'
            || plan.version !== 1 || !isAccountId(plan.lineage) || !/^[1-9][0-9]*$/u.test(plan.guardGeneration)
            || plan.database !== deps.pins.database || plan.currentUser !== deps.pins.currentUser || plan.serverUuid !== deps.pins.serverUuid
            || plan.sourceCommit !== deps.sourceCommit || confirmation.sha256 !== plan.sha256
            || confirmation.writers !== 'ORIGINAL PRIMARY AND ALL WRITERS FENCED') throw new Error();
        const { sha256, ...body } = plan, now = (deps.now ?? Date.now)(), created = Date.parse(plan.createdAt);
        if (digest(body) !== sha256 || !Number.isFinite(created) || now < created || now - created > 300_000) throw new Error();
        for (const name of [migrationLockName(deps.pins.database), runtimeGrantLockName(deps.pins.database, PRODUCTION_RUNTIME_DATABASE_ACCOUNT)]) {
            const [rows] = await deps.connection.query<RowDataPacket[]>({ sql: 'SELECT GET_LOCK(?, 5) AS acquired', timeout: 10_000 }, [name]);
            if (!Array.isArray(rows) || rows.length !== 1 || Number(rows[0].acquired) !== 1) throw new Error();
            locks.push(name);
        }
        const guard = await state(deps);
        if (guard.generation !== plan.guardGeneration) throw new Error();
        await deps.verifyWritersFenced(deps.connection);
        ddlStarted = true;
        await deps.connection.query({ sql: sql(), timeout: 10_000 });
        await deps.connection.query({ sql: 'INSERT INTO account_recovery_checkpoint (singleton_id,lineage_id,epoch) VALUES (1,?,0)',
            timeout: 10_000 }, [plan.lineage]);
        await verifyRecoveryCheckpointSchema(deps.connection);
        const [rows] = await deps.connection.query<RowDataPacket[]>({ sql: `SELECT lineage_id AS lineage,CAST(epoch AS CHAR) AS epoch
            FROM account_recovery_checkpoint WHERE singleton_id=1 LIMIT 2`, timeout: 10_000 });
        if (!Array.isArray(rows) || rows.length !== 1 || rows[0].lineage !== plan.lineage || rows[0].epoch !== '0'
            || JSON.stringify(await deps.guard.readRestoreGuard()) !== JSON.stringify(guard)) throw new Error();
        completed = true;
    } catch {
        if (ddlStarted) deps.connection.destroy();
        throw new Error(FAILURE);
    } finally {
        if (!ddlStarted || completed) for (const name of locks.reverse()) {
            try { await deps.connection.query('SELECT RELEASE_LOCK(?)', [name]); }
            catch { deps.connection.destroy(); break; }
        }
    }
}
