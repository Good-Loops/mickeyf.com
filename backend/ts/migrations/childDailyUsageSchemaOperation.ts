import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MigrationConnection } from './leaderboardSchema';
import { verifyHistoryTable } from './leaderboardSchema';
import { loadMigrationManifest } from './migrationManifest';
import { migrationLockName } from './migrationRunner';
import { runtimeGrantLockName } from '../security/runtimeGrantOperations';
import { PRODUCTION_RUNTIME_DATABASE_ACCOUNT } from '../security/runtimeGrantManifest';
import { assertChildReleaseSafety, childSignedFormFingerprint, type ChildReleaseSafety } from './childSignedFormOperation';
import type { ChildSignedFormMetadataSettings, ChildSignedFormSource } from './childSignedFormMetadata';
import { verifyChildDailyUsageSchema, verifyChildDailyUsageReceiptSchema } from './childDailyUsageSchema';

// These two CREATEs remain outside the historical 0001–0026 migration manifest.
export const DAILY_USAGE_SCHEMA_FILES = [
    { name: 'draft_parent_child_daily_usage.sql', table: 'parent_child_daily_usage',
        sha256: '18381cbeb4db9206949a73d9f167c57e6a865679f9ef83dfb8a05c830e7c0f2f', verify: verifyChildDailyUsageSchema },
    { name: 'draft_child_daily_usage_withdrawal_receipts.sql', table: 'child_daily_usage_withdrawal_receipts',
        sha256: '501ca53cb338161927ae8e33fdb5545ffc3a7476ee72876851804479eacdadaf', verify: verifyChildDailyUsageReceiptSchema },
] as const;
type Snapshot = Readonly<{ database: string; user: string; serverUuid: string; serverVersion: string; versionComment: string;
    history: string; tables: readonly Readonly<{ name: string; present: boolean }>[] }>;
export type DailyUsageSchemaPlan = Readonly<{ version: 1; operation: 'create-daily-usage-tables'; createdAt: string;
    sourceCommit: string; sqlHashes: readonly string[]; snapshot: Snapshot; safety: ChildReleaseSafety; sha256: string }>;
export type DailyUsageSchemaDependencies = Readonly<{ connection: MigrationConnection; settings: ChildSignedFormMetadataSettings;
    source: ChildSignedFormSource; assertSource: () => void; observeSafety: (plan?: DailyUsageSchemaPlan) => Promise<ChildReleaseSafety>;
    now?: () => number }>;
export class DailyUsageSchemaError extends Error {
    constructor(readonly state: 'blocked' | 'indeterminate') {
        super(state === 'indeterminate' ? 'Daily usage schema may be partially applied. Reconnect and verify or make a fresh plan; do not retry this plan.'
            : 'Daily usage schema operation blocked before DDL.');
    }
}
const fail = (): never => { throw new DailyUsageSchemaError('blocked'); };
const fingerprint = childSignedFormFingerprint;
function sqlFiles(deps: DailyUsageSchemaDependencies): string[] {
    deps.assertSource();
    if (!/^[a-f0-9]{40}$/u.test(deps.source.sourceCommit)) return fail();
    return DAILY_USAGE_SCHEMA_FILES.map(file => {
        const bytes = readFileSync(path.resolve(__dirname, '../../migrations/pending', file.name));
        if (createHash('sha256').update(bytes).digest('hex') !== file.sha256 || bytes.includes(13)) return fail();
        const sql = bytes.toString('utf8'), body = sql.replace(/--[^\n]*(?:\n|$)/gu, '\n').trim();
        if (!body.startsWith(`CREATE TABLE ${file.table} (`) || !body.endsWith(';') || body.slice(0, -1).includes(';')) return fail();
        return sql;
    });
}
async function snapshot(deps: DailyUsageSchemaDependencies): Promise<Snapshot> {
    const [identity] = await deps.connection.query(`SELECT DATABASE() AS databaseName,CURRENT_USER() AS currentUser,
        @@GLOBAL.server_uuid AS serverUuid,@@version AS serverVersion,@@version_comment AS versionComment`);
    if (!Array.isArray(identity) || identity.length !== 1) return fail();
    const row = identity[0], expected = deps.settings;
    if (row.databaseName !== expected.target.database || row.currentUser !== expected.expectedCurrentUser
        || row.serverUuid !== expected.target.serverUuid || row.serverVersion !== expected.expectedServerVersion
        || row.versionComment !== expected.expectedVersionComment) return fail();
    await verifyHistoryTable(deps.connection);
    const [history] = await deps.connection.query('SELECT version, LOWER(HEX(checksum)) AS checksum FROM schema_migrations ORDER BY version');
    const expectedHistory = loadMigrationManifest().map(item => ({ version: item.version, checksum: item.checksum.toString('hex') }));
    if (!Array.isArray(history) || fingerprint(history.map(item => ({ version: item.version, checksum: item.checksum })))
        !== fingerprint(expectedHistory)) return fail();
    const [base] = await deps.connection.query(`SELECT TABLE_NAME AS name,ENGINE AS engine,TABLE_TYPE AS type
        FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='parent_child_consents'`);
    if (!Array.isArray(base) || base.length !== 1 || base[0].engine !== 'InnoDB' || base[0].type !== 'BASE TABLE') return fail();
    const tables: { name: string; present: boolean }[] = [];
    for (const file of DAILY_USAGE_SCHEMA_FILES) {
        const [rows] = await deps.connection.query(`SELECT TABLE_NAME AS name FROM information_schema.TABLES
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`, [file.table]);
        if (!Array.isArray(rows) || rows.length > 1 || (rows.length === 1 && rows[0].name !== file.table)) return fail();
        if (rows.length) await file.verify(deps.connection);
        tables.push({ name: file.table, present: rows.length === 1 });
    }
    return { database: row.databaseName, user: row.currentUser, serverUuid: row.serverUuid,
        serverVersion: row.serverVersion, versionComment: row.versionComment, history: fingerprint(expectedHistory), tables };
}
export async function planDailyUsageSchema(deps: DailyUsageSchemaDependencies): Promise<DailyUsageSchemaPlan> {
    try {
        sqlFiles(deps);
        const safety = await deps.observeSafety(); assertChildReleaseSafety(safety, deps, (deps.now ?? Date.now)());
        const state = await snapshot(deps); sqlFiles(deps);
        assertChildReleaseSafety(safety, deps, (deps.now ?? Date.now)());
        const body = { version: 1 as const, operation: 'create-daily-usage-tables' as const,
            createdAt: new Date((deps.now ?? Date.now)()).toISOString(), sourceCommit: deps.source.sourceCommit,
            sqlHashes: DAILY_USAGE_SCHEMA_FILES.map(file => file.sha256), snapshot: state, safety };
        return { ...body, sha256: fingerprint(body) };
    } catch { return fail(); }
}
function assertPlan(deps: DailyUsageSchemaDependencies, plan: DailyUsageSchemaPlan,
    approval: Readonly<{ allow: boolean; planSha256: string; serverUuid: string }>): void {
    if (!plan || Object.keys(plan).sort().join(',') !== 'createdAt,operation,safety,sha256,snapshot,sourceCommit,sqlHashes,version') return fail();
    const { sha256, ...body } = plan, created = Date.parse(plan.createdAt), now = (deps.now ?? Date.now)();
    if (approval.allow !== true || approval.serverUuid !== deps.settings.target.serverUuid || approval.planSha256 !== sha256
        || !/^[a-f0-9]{64}$/u.test(sha256) || fingerprint(body) !== sha256 || plan.version !== 1
        || plan.operation !== 'create-daily-usage-tables' || plan.sourceCommit !== deps.source.sourceCommit
        || fingerprint(plan.sqlHashes) !== fingerprint(DAILY_USAGE_SCHEMA_FILES.map(file => file.sha256))
        || !Number.isFinite(created) || new Date(created).toISOString() !== plan.createdAt || now < created || now - created > 300_000
        || created < Date.parse(plan.safety.observedAt)) return fail();
    assertChildReleaseSafety(plan.safety, deps, created);
}
function receipt(deps: DailyUsageSchemaDependencies, state: Snapshot) {
    const body = { version: 1 as const, operation: 'verify-daily-usage-tables' as const,
        verifiedAt: new Date((deps.now ?? Date.now)()).toISOString(), sourceCommit: deps.source.sourceCommit,
        sqlHashes: DAILY_USAGE_SCHEMA_FILES.map(file => file.sha256), snapshot: state };
    return { ...body, sha256: fingerprint(body) };
}
export async function applyDailyUsageSchema(deps: DailyUsageSchemaDependencies, plan: DailyUsageSchemaPlan,
    approval: Readonly<{ allow: boolean; planSha256: string; serverUuid: string }>) {
    let ddlStarted = false, discarded = false;
    const locks: string[] = [];
    const discard = () => { discarded = true; try { deps.connection.destroy?.(); } catch { /* Keep sanitized outcome. */ } };
    try {
        const sql = sqlFiles(deps); assertPlan(deps, plan, approval);
        assertChildReleaseSafety(await deps.observeSafety(plan), deps, (deps.now ?? Date.now)(), plan.safety);
        await deps.connection.query('SET SESSION autocommit = 1');
        await deps.connection.query("SET SESSION time_zone = '+00:00'");
        await deps.connection.query('SET SESSION lock_wait_timeout = 10');
        for (const name of [migrationLockName(deps.settings.target.database), runtimeGrantLockName(deps.settings.target.database, PRODUCTION_RUNTIME_DATABASE_ACCOUNT)]) {
            const [rows] = await deps.connection.query('SELECT GET_LOCK(?, 5) AS acquired', [name]);
            if (!Array.isArray(rows) || rows.length !== 1 || Number(rows[0].acquired) !== 1) return fail();
            locks.push(name);
        }
        if (fingerprint(await snapshot(deps)) !== fingerprint(plan.snapshot)) return fail();
        assertChildReleaseSafety(await deps.observeSafety(plan), deps, (deps.now ?? Date.now)(), plan.safety);
        sqlFiles(deps); assertPlan(deps, plan, approval);
        for (const [index, statement] of sql.entries()) {
            if (plan.snapshot.tables[index].present) continue;
            ddlStarted = true; await deps.connection.query(statement);
        }
        const after = await snapshot(deps);
        const expected = { ...plan.snapshot, tables: plan.snapshot.tables.map(table => ({ ...table, present: true })) };
        if (fingerprint(after) !== fingerprint(expected)) return fail();
        sqlFiles(deps);
        return receipt(deps, after);
    } catch {
        if (ddlStarted) { discard(); throw new DailyUsageSchemaError('indeterminate'); }
        return fail();
    } finally {
        if (!discarded) for (const lock of [...locks].reverse()) {
            try {
                const [rows] = await deps.connection.query('SELECT RELEASE_LOCK(?) AS released', [lock]);
                if (!Array.isArray(rows) || rows.length !== 1 || Number(rows[0].released) !== 1) throw new Error();
            } catch { discard(); throw new DailyUsageSchemaError(ddlStarted ? 'indeterminate' : 'blocked'); }
        }
    }
}

/** A fresh read-only connection resolves an uncertain outcome without issuing or undoing DDL. */
export async function verifyDailyUsageSchema(deps: DailyUsageSchemaDependencies) {
    try {
        sqlFiles(deps); const state = await snapshot(deps);
        if (state.tables.some(table => !table.present)) return fail();
        sqlFiles(deps); return receipt(deps, state);
    } catch { return fail(); }
}
