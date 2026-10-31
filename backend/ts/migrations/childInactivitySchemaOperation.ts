import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MigrationConnection } from './leaderboardSchema';
import { loadMigrationManifest } from './migrationManifest';
import { migrationLockName } from './migrationRunner';
import { runtimeGrantLockName } from '../security/runtimeGrantOperations';
import { PRODUCTION_RUNTIME_DATABASE_ACCOUNT } from '../security/runtimeGrantManifest';
import { assertChildReleaseSafety, childSignedFormFingerprint, type ChildReleaseSafety } from './childSignedFormOperation';
import type { ChildSignedFormMetadataSettings, ChildSignedFormSource } from './childSignedFormMetadata';

const files = [
    { name: 'draft_create_parent_managed_child_activity.sql', sha256: 'bd927931230a1b677b279612c4e1f9958fa80f8bedac614aa4bf84df0a623eff' },
    { name: 'draft_parent_child_inactivity_warnings.sql', sha256: '67c60d54a5d435a8e8a4204f164943e17c5f2418d7ebea78c4ce5aad439f1add' },
] as const;
const tableNames = ['parent_child_inactivity_warnings', 'parent_managed_child_activity'] as const;
type Snapshot = Readonly<{ database: string; user: string; serverUuid: string; serverVersion: string; versionComment: string; history: string }>;
export type InactivitySchemaPlan = Readonly<{ version: 1; operation: 'create-inactivity-tables'; createdAt: string;
    sourceCommit: string; sqlHashes: readonly string[]; snapshot: Snapshot; safety: ChildReleaseSafety; sha256: string }>;
export type InactivitySchemaDependencies = Readonly<{ connection: MigrationConnection; settings: ChildSignedFormMetadataSettings;
    source: ChildSignedFormSource; assertSource: () => void; observeSafety: (plan?: InactivitySchemaPlan) => Promise<ChildReleaseSafety>;
    now?: () => number }>;
export class InactivitySchemaError extends Error {
    constructor(readonly state: 'blocked' | 'indeterminate') {
        super(state === 'indeterminate' ? 'Schema operation may be partially applied. Inspect before recovery; do not retry.'
            : 'Schema operation blocked before DDL.');
    }
}
const fail = (): never => { throw new InactivitySchemaError('blocked'); };
function sqlFiles(deps: InactivitySchemaDependencies): string[] {
    deps.assertSource();
    if (!/^[a-f0-9]{40}$/u.test(deps.source.sourceCommit)) return fail();
    return files.map(file => {
        const data = readFileSync(path.resolve(__dirname, '../../migrations/pending', file.name));
        if (createHash('sha256').update(data).digest('hex') !== file.sha256 || data.includes(13)) return fail();
        const sql = data.toString('utf8'), body = sql.replace(/--[^\n]*(?:\n|$)/gu, '\n').trim();
        if (!body.endsWith(';') || body.slice(0, -1).includes(';') || !body.startsWith('CREATE TABLE ')) return fail();
        return sql;
    });
}
async function snapshot(deps: InactivitySchemaDependencies): Promise<Snapshot> {
    const [identity] = await deps.connection.query(`SELECT DATABASE() AS databaseName,CURRENT_USER() AS currentUser,
        @@GLOBAL.server_uuid AS serverUuid,@@version AS serverVersion,@@version_comment AS versionComment`);
    if (!Array.isArray(identity) || identity.length !== 1) return fail();
    const row = identity[0], expected = deps.settings;
    if (row.databaseName !== expected.target.database || row.currentUser !== expected.expectedCurrentUser
        || row.serverUuid !== expected.target.serverUuid || row.serverVersion !== expected.expectedServerVersion
        || row.versionComment !== expected.expectedVersionComment) return fail();
    const [base] = await deps.connection.query(`SELECT TABLE_NAME AS name,ENGINE AS engine,TABLE_TYPE AS type
        FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='parent_child_consents'`);
    if (!Array.isArray(base) || base.length !== 1 || base[0].engine !== 'InnoDB' || base[0].type !== 'BASE TABLE') return fail();
    const [history] = await deps.connection.query('SELECT version, LOWER(HEX(checksum)) AS checksum FROM schema_migrations ORDER BY version');
    const expectedHistory = loadMigrationManifest().map(item => ({ version: item.version, checksum: item.checksum.toString('hex') }));
    if (!Array.isArray(history) || childSignedFormFingerprint(history.map(item => ({ version: item.version, checksum: item.checksum })))
        !== childSignedFormFingerprint(expectedHistory)) return fail();
    return { database: row.databaseName, user: row.currentUser, serverUuid: row.serverUuid, serverVersion: row.serverVersion,
        versionComment: row.versionComment, history: childSignedFormFingerprint(expectedHistory) };
}
async function assertTables(deps: InactivitySchemaDependencies, present: boolean): Promise<void> {
    const [rows] = await deps.connection.query(`SELECT TABLE_NAME AS name,ENGINE AS engine,TABLE_TYPE AS type
        FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME IN ('parent_managed_child_activity','parent_child_inactivity_warnings') ORDER BY TABLE_NAME`);
    if (!Array.isArray(rows) || (!present && rows.length !== 0) || (present && (rows.length !== 2
        || rows.some((row, index) => row.name !== tableNames[index] || row.engine !== 'InnoDB' || row.type !== 'BASE TABLE')))) return fail();
    if (!present) return;
    const [columns] = await deps.connection.query(`SELECT TABLE_NAME AS tableName,COLUMN_NAME AS name,COLUMN_TYPE AS type,
        IS_NULLABLE AS nullable,CHARACTER_SET_NAME AS charset,COLLATION_NAME AS collation,EXTRA AS extra,GENERATION_EXPRESSION AS generation FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('parent_managed_child_activity','parent_child_inactivity_warnings')
        ORDER BY TABLE_NAME,ORDINAL_POSITION`);
    const warningColumns = [
        ['child_uuid','char(36)','NO','ascii','ascii_bin'], ['parent_uuid','char(36)','NO','ascii','ascii_bin'],
        ['warning_uuid','char(36)','NO','ascii','ascii_bin'], ['activity_at','datetime(6)','NO',null,null],
        ['channel',"enum('in-app','email')",'NO','utf8mb4','utf8mb4_unicode_ci'], ['target_digest','binary(32)','NO',null,null],
        ['notice_digest','binary(32)','NO',null,null], ['prepared_at','datetime(6)','NO',null,null],
        ['delivered_at','datetime(6)','YES',null,null], ['receipt_digest','binary(32)','YES',null,null],
    ];
    const activityColumns = [['child_uuid','char(36)','NO','ascii','ascii_bin'], ['retention_activity_at','datetime(6)','NO',null,null]];
    const expected = [...warningColumns.map(values => [tableNames[0], ...values]), ...activityColumns.map(values => [tableNames[1], ...values])];
    if (!Array.isArray(columns) || columns.length !== expected.length || columns.some((row, index) =>
        childSignedFormFingerprint([row.tableName,row.name,row.type,row.nullable,row.charset,row.collation]) !== childSignedFormFingerprint(expected[index])
        || row.extra !== '' || row.generation !== '')) return fail();
    const [foreign] = await deps.connection.query(`SELECT k.TABLE_NAME AS tableName,k.COLUMN_NAME AS col,k.REFERENCED_TABLE_NAME AS target,
        k.REFERENCED_COLUMN_NAME AS targetCol,k.REFERENCED_TABLE_SCHEMA=DATABASE() AS sameSchema,r.DELETE_RULE AS deletion,r.UPDATE_RULE AS updateRule
        FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME IN ('parent_managed_child_activity','parent_child_inactivity_warnings')
        AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME`);
    const expectedForeign = [{ tableName: tableNames[0], col:'child_uuid', target:'parent_managed_child_activity', targetCol:'child_uuid', sameSchema:1, deletion:'CASCADE', updateRule:'RESTRICT' },
        { tableName: tableNames[1], col:'child_uuid', target:'parent_child_consents', targetCol:'child_uuid', sameSchema:1, deletion:'CASCADE', updateRule:'RESTRICT' }];
    if (!Array.isArray(foreign) || childSignedFormFingerprint(foreign.map(row => ({ ...row }))) !== childSignedFormFingerprint(expectedForeign)) return fail();
    const [indexes] = await deps.connection.query(`SELECT TABLE_NAME AS tableName,INDEX_NAME AS name,COLUMN_NAME AS col,NON_UNIQUE AS nonUnique,SEQ_IN_INDEX AS seq
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME IN ('parent_managed_child_activity','parent_child_inactivity_warnings') ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX`);
    const expectedIndexes = [{ tableName:tableNames[0], name:'idx_inactivity_warning_id', col:'warning_uuid', nonUnique:0, seq:1 },
        { tableName:tableNames[0], name:'PRIMARY', col:'child_uuid', nonUnique:0, seq:1 },
        { tableName:tableNames[1], name:'PRIMARY', col:'child_uuid', nonUnique:0, seq:1 }];
    if (!Array.isArray(indexes) || childSignedFormFingerprint(indexes.map(row => ({ ...row }))) !== childSignedFormFingerprint(expectedIndexes)) return fail();
    const [triggers] = await deps.connection.query(`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()
        AND EVENT_OBJECT_TABLE IN ('parent_managed_child_activity','parent_child_inactivity_warnings')`);
    if (!Array.isArray(triggers) || triggers.length !== 0) return fail();
    const [checks] = await deps.connection.query(`SELECT TABLE_NAME AS tableName,CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('parent_managed_child_activity','parent_child_inactivity_warnings') AND CONSTRAINT_TYPE='CHECK'`);
    if (!Array.isArray(checks) || checks.length !== 1 || checks[0].tableName !== tableNames[0]
        || checks[0].name !== 'chk_inactivity_warning_receipt') return fail();
}
export async function planInactivitySchema(deps: InactivitySchemaDependencies): Promise<InactivitySchemaPlan> {
    try {
        sqlFiles(deps);
        const safety = await deps.observeSafety(); assertChildReleaseSafety(safety, deps, (deps.now ?? Date.now)());
        const state = await snapshot(deps); await assertTables(deps, false); sqlFiles(deps);
        const body = { version: 1 as const, operation: 'create-inactivity-tables' as const,
            createdAt: new Date((deps.now ?? Date.now)()).toISOString(), sourceCommit: deps.source.sourceCommit,
            sqlHashes: files.map(file => file.sha256), snapshot: state, safety };
        return { ...body, sha256: childSignedFormFingerprint(body) };
    } catch { return fail(); }
}
export async function applyInactivitySchema(deps: InactivitySchemaDependencies, plan: InactivitySchemaPlan,
    approval: Readonly<{ allow: boolean; planSha256: string; serverUuid: string }>): Promise<void> {
    let ddlStarted = false; const locks: string[] = []; const now = deps.now ?? Date.now;
    try {
        const sql = sqlFiles(deps);
        if (!plan || Object.keys(plan).sort().join(',') !== 'createdAt,operation,safety,sha256,snapshot,sourceCommit,sqlHashes,version') return fail();
        const { sha256, ...body } = plan, created = Date.parse(plan.createdAt);
        if (approval.allow !== true || approval.serverUuid !== deps.settings.target.serverUuid || approval.planSha256 !== sha256
            || !/^[a-f0-9]{64}$/u.test(sha256) || childSignedFormFingerprint(body) !== sha256 || plan.version !== 1
            || plan.operation !== 'create-inactivity-tables' || plan.sourceCommit !== deps.source.sourceCommit
            || childSignedFormFingerprint(plan.sqlHashes) !== childSignedFormFingerprint(files.map(file => file.sha256))
            || !Number.isFinite(created) || now() < created || now() - created > 300_000) return fail();
        const safety = await deps.observeSafety(plan); assertChildReleaseSafety(safety, deps, now(), plan.safety);
        await deps.connection.query('SET SESSION autocommit = 1');
        await deps.connection.query("SET SESSION time_zone = '+00:00'");
        await deps.connection.query('SET SESSION lock_wait_timeout = 10');
        for (const name of [migrationLockName(deps.settings.target.database), runtimeGrantLockName(deps.settings.target.database, PRODUCTION_RUNTIME_DATABASE_ACCOUNT)]) {
            const [rows] = await deps.connection.query('SELECT GET_LOCK(?, 5) AS acquired', [name]);
            if (!Array.isArray(rows) || rows.length !== 1 || Number(rows[0].acquired) !== 1) return fail();
            locks.push(name);
        }
        if (childSignedFormFingerprint(await snapshot(deps)) !== childSignedFormFingerprint(plan.snapshot)) return fail();
        await assertTables(deps, false); sqlFiles(deps);
        const currentSafety = await deps.observeSafety(plan); assertChildReleaseSafety(currentSafety, deps, now(), plan.safety);
        if (now() - created > 300_000) return fail();
        for (const statement of sql) { ddlStarted = true; await deps.connection.query(statement); }
        await assertTables(deps, true);
        if (childSignedFormFingerprint(await snapshot(deps)) !== childSignedFormFingerprint(plan.snapshot)) return fail();
    } catch { if (ddlStarted) { deps.connection.destroy?.(); throw new InactivitySchemaError('indeterminate'); } return fail(); }
    finally {
        if (!ddlStarted || locks.length) {
            for (const lock of [...locks].reverse()) {
                try {
                    const [rows] = await deps.connection.query('SELECT RELEASE_LOCK(?) AS released', [lock]);
                    if (!Array.isArray(rows) || rows.length !== 1 || Number(rows[0].released) !== 1) throw new Error();
                } catch { deps.connection.destroy?.(); if (ddlStarted) throw new InactivitySchemaError('indeterminate'); }
            }
        }
    }
}
