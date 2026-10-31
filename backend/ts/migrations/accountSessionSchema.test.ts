import assert from 'node:assert/strict';
import test from 'node:test';
import type { MigrationConnection } from './leaderboardSchema';
import { ACCOUNT_SESSION_MIGRATION_VERSION, ACCOUNT_SESSION_RENEWAL_MIGRATION_VERSION,
    APPLE_SESSION_PROVENANCE_MIGRATION_VERSION,
    verifyAccountSessionSchema, verifyOptionalAccountSessionSchema, verifyRenewableAccountSessionSchema } from './accountSessionSchema';

type Metadata = Record<string, Array<Record<string, unknown>>>;
function fixture(renewable = false, appleProvenance = false): Metadata {
    const column = (name: string, type: string, characterSet: string | null = null,
        collation: string | null = null, datetimePrecision: number | null = null, comment = '') => ({
        name, type, nullable: 'NO', characterSet, collation, defaultValue: null, extra: '',
        datetimePrecision, comment, generationExpression: '',
    });
    const index = (name: string, columnName: string, nonUnique: number, sequence = 1) => ({
        name, sequence, columnName, nonUnique, indexOrder: 'A', subPart: null, visible: 'YES', indexType: 'BTREE',
    });
    const metadata: Metadata = {
        TABLES: [{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', tableType: 'BASE TABLE' }],
        COLUMNS: [column('session_hash', 'binary(32)'), column('account_uuid', 'char(36)', 'ascii', 'ascii_bin'),
            column('created_at', 'datetime(6)', null, null, 6, 'UTC'),
            column('expires_at', 'datetime(6)', null, null, 6, 'UTC')],
        STATISTICS: [index('idx_account_sessions_account_created', 'account_uuid', 1),
            index('idx_account_sessions_account_created', 'created_at', 1, 2),
            index('idx_account_sessions_expiry', 'expires_at', 1), index('PRIMARY', 'session_hash', 0)],
        KEY_COLUMN_USAGE: [{ name: 'fk_account_sessions_account', sequence: 1, columnName: 'account_uuid',
            referencedTable: 'users', referencedColumn: 'account_uuid', sameSchema: 1,
            deleteRule: 'CASCADE', updateRule: 'RESTRICT' }],
        TABLE_CONSTRAINTS: [], TRIGGERS: [],
    };
    if (renewable) {
        metadata.COLUMNS.push({ ...column('remembered', 'tinyint'), defaultValue: '0' },
            { ...column('renewed_at', 'datetime(6)', null, null, 6, 'UTC'), nullable: 'YES' },
            { ...column('previous_session_hash', 'binary(32)'), nullable: 'YES' },
            { ...column('previous_valid_until', 'datetime(6)', null, null, 6, 'UTC'), nullable: 'YES' });
        metadata.STATISTICS.push(index('uq_account_sessions_previous_hash', 'previous_session_hash', 0));
    }
    if (appleProvenance) {
        metadata.COLUMNS.push({ ...column('apple_subject_hash', 'binary(32)'), nullable: 'YES' },
            { ...column('apple_authenticated_at', 'bigint unsigned'), nullable: 'YES' });
        metadata.TABLE_CONSTRAINTS.push({ name: 'chk_account_sessions_apple_provenance' });
        metadata.CHECK_CONSTRAINTS = [{ clause: '(((`apple_subject_hash` is null) and (`apple_authenticated_at` is null)) or ((`apple_subject_hash` is not null) and (`apple_authenticated_at` is not null) and (`apple_authenticated_at` > 0)))', enforced: 'YES' }];
    }
    return metadata;
}
function source(metadata = fixture(), options: { exists?: boolean; recorded?: boolean; renewalRecorded?: boolean; provenanceRecorded?: boolean } = {}): MigrationConnection {
    return { async query(sql, values) {
        if (sql.includes('COUNT(*)') && sql.includes('information_schema.TABLES')) {
            assert.deepEqual(values, ['account_sessions']);
            return [[{ tableCount: options.exists === false ? 0 : 1 }], []];
        }
        if (sql.includes('FROM schema_migrations')) {
            assert(values?.every(version => [ACCOUNT_SESSION_MIGRATION_VERSION, ACCOUNT_SESSION_RENEWAL_MIGRATION_VERSION, APPLE_SESSION_PROVENANCE_MIGRATION_VERSION].includes(String(version))));
            return [[...(options.recorded && values?.includes(ACCOUNT_SESSION_MIGRATION_VERSION)
                ? [{ version: ACCOUNT_SESSION_MIGRATION_VERSION }] : []),
            ...(options.renewalRecorded && values?.includes(ACCOUNT_SESSION_RENEWAL_MIGRATION_VERSION)
                ? [{ version: ACCOUNT_SESSION_RENEWAL_MIGRATION_VERSION }] : []),
            ...(options.provenanceRecorded && values?.includes(APPLE_SESSION_PROVENANCE_MIGRATION_VERSION)
                ? [{ version: APPLE_SESSION_PROVENANCE_MIGRATION_VERSION }] : [])], []];
        }
        if (sql.includes('COLUMN_NAME IN')) {
            const selected = sql.includes('apple_subject_hash') ? ['apple_subject_hash', 'apple_authenticated_at']
                : ['remembered', 'renewed_at', 'previous_session_hash', 'previous_valid_until'];
            return [metadata.COLUMNS.filter(column => selected.includes(String(column.name))).map(({ name }) => ({ name })), []];
        }
        const category = /FROM information_schema\.([A-Z_]+)/u.exec(sql)?.[1];
        if (!category || !metadata[category]) throw new Error('Unexpected schema query');
        assert.deepEqual(values, ['account_sessions']);
        return [metadata[category], []];
    } };
}

test('session schema requires exact hashed keys, indexed expiry and immutable-account deletion cascade', async () => {
    await verifyAccountSessionSchema(source());
    await verifyOptionalAccountSessionSchema(source());
    const mutations: Array<(metadata: Metadata) => void> = [
        m => { m.TABLES[0].engine = 'MyISAM'; }, m => { m.TABLES[0].tableType = 'VIEW'; },
        m => { m.COLUMNS[0].type = 'varchar(43)'; }, m => { m.COLUMNS[1].nullable = 'YES'; },
        m => { m.COLUMNS[1].collation = 'ascii_general_ci'; }, m => { m.COLUMNS[2].extra = 'on update CURRENT_TIMESTAMP'; },
        m => { m.COLUMNS[3].comment = ''; }, m => { m.COLUMNS[3].defaultValue = 'CURRENT_TIMESTAMP'; },
        m => { m.COLUMNS.push({ ...m.COLUMNS[0], name: 'raw_token' }); },
        m => { m.STATISTICS[0].columnName = 'user_id'; }, m => { m.STATISTICS[1].sequence = 1; },
        m => { m.STATISTICS[2].visible = 'NO'; }, m => { m.STATISTICS[3].nonUnique = 1; },
        m => { m.KEY_COLUMN_USAGE.length = 0; }, m => { m.KEY_COLUMN_USAGE[0].deleteRule = 'RESTRICT'; },
        m => { m.KEY_COLUMN_USAGE[0].updateRule = 'CASCADE'; }, m => { m.KEY_COLUMN_USAGE[0].sameSchema = 0; },
        m => { m.TABLE_CONSTRAINTS.push({ name: 'unexpected_check' }); },
        m => { m.TRIGGERS.push({ name: 'restore_session' }); },
    ];
    for (const mutate of mutations) {
        const metadata = fixture(); mutate(metadata);
        await assert.rejects(verifyAccountSessionSchema(source(metadata)), /reviewed schema/u);
    }
});

test('pre-0011 backups may omit sessions; missing recorded sessions and unavailable metadata fail closed', async () => {
    await verifyOptionalAccountSessionSchema(source(fixture(), { exists: false }));
    await assert.rejects(verifyOptionalAccountSessionSchema(source(fixture(), { exists: false, recorded: true })),
        /missing its table/u);
    await assert.rejects(verifyAccountSessionSchema({ async query() { return [{}, []]; } }), /metadata is unavailable/u);
});

test('renewal schema is exact; old backups remain valid but partial or missing recorded renewal fails closed', async () => {
    await verifyRenewableAccountSessionSchema(source(fixture(true)));
    await verifyOptionalAccountSessionSchema(source(fixture(true), { recorded: true, renewalRecorded: true }));
    await assert.rejects(verifyRenewableAccountSessionSchema(source()), /reviewed schema/u);
    await assert.rejects(verifyOptionalAccountSessionSchema(source(fixture(), { renewalRecorded: true })), /missing its columns/u);
    await assert.rejects(verifyOptionalAccountSessionSchema(source(fixture(), { exists: false, renewalRecorded: true })), /missing its table/u);
    const incomplete = fixture(true); incomplete.COLUMNS.pop();
    await assert.rejects(verifyOptionalAccountSessionSchema(source(incomplete)), /incomplete/u);
    for (const mutate of [
        (m: Metadata) => { m.COLUMNS[4].defaultValue = '1'; },
        (m: Metadata) => { m.COLUMNS[5].extra = 'on update CURRENT_TIMESTAMP'; },
        (m: Metadata) => { m.COLUMNS[5].comment = ''; },
        (m: Metadata) => { m.COLUMNS[6].type = 'varchar(43)'; },
        (m: Metadata) => { m.COLUMNS[7].nullable = 'NO'; },
        (m: Metadata) => { m.STATISTICS.at(-1)!.nonUnique = 1; },
    ]) {
        const metadata = fixture(true); mutate(metadata);
        await assert.rejects(verifyOptionalAccountSessionSchema(source(metadata)), /reviewed schema/u);
    }
});

test('Apple provenance is paired, immutable by schema defaults, and compatible with earlier session checks', async () => {
    await verifyAccountSessionSchema(source(fixture(true, true)), true, true);
    await verifyRenewableAccountSessionSchema(source(fixture(true, true)));
    await verifyOptionalAccountSessionSchema(source(fixture(true, true), { provenanceRecorded: true }));
    await assert.rejects(verifyOptionalAccountSessionSchema(source(fixture(true), { provenanceRecorded: true })), /missing its columns/u);
    await assert.rejects(verifyOptionalAccountSessionSchema(source(fixture(), { exists: false, provenanceRecorded: true })), /missing its table/u);
    const partial = fixture(true, true); partial.COLUMNS.pop();
    await assert.rejects(verifyOptionalAccountSessionSchema(source(partial)), /incomplete/u);
    for (const mutate of [
        (data: Metadata) => { data.COLUMNS[8].nullable = 'NO'; },
        (data: Metadata) => { data.COLUMNS[9].type = 'bigint'; },
        (data: Metadata) => { data.CHECK_CONSTRAINTS[0].enforced = 'NO'; },
        (data: Metadata) => { data.CHECK_CONSTRAINTS[0].clause = 'apple_authenticated_at > 0'; },
        (data: Metadata) => { data.TABLE_CONSTRAINTS.length = 0; },
    ]) {
        const data = fixture(true, true); mutate(data);
        await assert.rejects(verifyOptionalAccountSessionSchema(source(data)), /reviewed schema/u);
    }
});
