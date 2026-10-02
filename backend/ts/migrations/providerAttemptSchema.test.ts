import assert from 'node:assert/strict';
import test from 'node:test';
import type { MigrationConnection } from './leaderboardSchema';
import {
    PROVIDER_ATTEMPT_MIGRATION_VERSION,
    PROVIDER_ATTEMPT_ACTIONS_MIGRATION_VERSION,
    inspectProviderAttemptStage,
    verifyOptionalProviderAttemptSchema,
    verifyProviderAttemptSchema,
} from './providerAttemptSchema';

type Metadata = Record<string, Array<Record<string, unknown>>>;

function fixture(): Metadata {
    const column = (name: string, type: string, characterSet: string | null = null,
        collation: string | null = null, nullable = 'NO', datetimePrecision: number | null = null, comment = '') => ({
        name, type, nullable, characterSet, collation, defaultValue: null, extra: '',
        datetimePrecision, comment, generationExpression: '',
    });
    const index = (name: string, columnName: string, nonUnique: number) => ({
        name, sequence: 1, columnName, nonUnique, indexOrder: 'A', subPart: null, visible: 'YES', indexType: 'BTREE',
    });
    return {
        TABLES: [{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', tableType: 'BASE TABLE' }],
        COLUMNS: [
            column('state_hash', 'binary(32)'), column('binding_hash', 'binary(32)'),
            column('nonce', 'char(43)', 'ascii', 'ascii_bin'),
            column('client_key', 'varchar(64)', 'ascii', 'ascii_bin'),
            column('action', 'varchar(8)', 'ascii', 'ascii_bin'), column('user_id', 'int', null, null, 'YES'),
            column('account_uuid', 'char(36)', 'ascii', 'ascii_bin', 'YES'),
            column('expires_at', 'datetime(6)', null, null, 'NO', 6, 'UTC'),
        ],
        STATISTICS: [index('idx_provider_auth_attempt_account', 'account_uuid', 1),
            index('idx_provider_auth_attempt_expiry', 'expires_at', 1), index('PRIMARY', 'state_hash', 0),
            index('uq_provider_auth_attempt_binding', 'binding_hash', 0)],
        KEY_COLUMN_USAGE: [{ name: 'fk_provider_auth_attempt_account', sequence: 1, columnName: 'account_uuid',
            referencedTable: 'users', referencedColumn: 'account_uuid', sameSchema: 1,
            deleteRule: 'CASCADE', updateRule: 'RESTRICT' }],
        TABLE_CONSTRAINTS: [{ name: 'chk_provider_auth_attempt_action',
            clause: "(cast(`action` as binary) in (cast(_utf8mb4'login' as binary),cast(_utf8mb4'link' as binary)))",
            enforced: 'YES' },
        { name: 'chk_provider_auth_attempt_user',
            clause: "((case when (cast(`action` as binary) = cast(_utf8mb4'login' as binary)) "
                + 'then (`user_id` is null) else coalesce((`user_id` > 0),0) end) = 1)',
            enforced: 'YES' }],
        TRIGGERS: [],
    };
}

function source(metadata = fixture(), options: { exists?: boolean; recorded?: boolean; extendedRecorded?: boolean } = {}): MigrationConnection {
    return { async query(sql, values) {
        if (sql.includes('COUNT(*)') && sql.includes('information_schema.TABLES')) {
            assert.deepEqual(values, ['provider_auth_attempts']);
            return [[{ tableCount: options.exists === false ? 0 : 1 }], []];
        }
        if (sql.includes('FROM schema_migrations')) {
            if (sql.includes('version IN')) {
                assert.deepEqual(values, [PROVIDER_ATTEMPT_MIGRATION_VERSION, PROVIDER_ATTEMPT_ACTIONS_MIGRATION_VERSION]);
                return [options.recorded || options.extendedRecorded ? [{ version: PROVIDER_ATTEMPT_MIGRATION_VERSION }] : [], []];
            }
            assert.deepEqual(values, [PROVIDER_ATTEMPT_ACTIONS_MIGRATION_VERSION]);
            return [options.extendedRecorded ? [{ version: PROVIDER_ATTEMPT_ACTIONS_MIGRATION_VERSION }] : [], []];
        }
        const category = /FROM information_schema\.([A-Z_]+)/u.exec(sql)?.[1];
        if (!category || !metadata[category]) throw new Error('Unexpected schema metadata query');
        assert.deepEqual(values, ['provider_auth_attempts']);
        return [metadata[category], []];
    } };
}

test('attempt schema accepts exact hashes, single-use keys, expiry index, and UUID cascade', async () => {
    await verifyProviderAttemptSchema(source());
    await verifyOptionalProviderAttemptSchema(source());
});

test('attempt checks accept MySQL 8.0.31 binary casts and escaped metadata without weakening action bytes', async () => {
    for (const escape of ['', '\\', '\\\\']) {
        const metadata = fixture();
        for (const check of metadata.TABLE_CONSTRAINTS) {
            check.clause = String(check.clause).replace(/as binary/gu, 'as char charset binary')
                .replace(/_utf8mb4'(login|link)'/gu,
                    (_match, value: string) => `_utf8mb4${escape}'${value}${escape}'`);
        }
        await verifyProviderAttemptSchema(source(metadata));
        for (const check of metadata.TABLE_CONSTRAINTS) {
            const original = String(check.clause);
            for (const invalidClause of [
                original.replace('login', 'LOGIN'),
                original.replace('login', 'login '),
                original.replace('login', 'lo\\gin'),
                original.replace(`login${escape}'`, `login\\${escape}'`),
                `${original} OR TRUE`,
                original.replace('as char charset binary', 'as char'),
            ]) {
                check.clause = invalidClause;
                await assert.rejects(verifyProviderAttemptSchema(source(metadata)), /checks/u);
            }
            check.clause = original;
        }
    }
});

test('attempt schema rejects altered transaction, identity, uniqueness, expiry, and deletion guarantees', async () => {
    const changes: Array<(metadata: Metadata) => void> = [
        m => { m.TABLES[0].engine = 'MyISAM'; },
        m => { m.TABLES[0].tableType = 'VIEW'; },
        m => { m.COLUMNS[0].type = 'varbinary(32)'; },
        m => { m.COLUMNS[1].nullable = 'YES'; },
        m => { m.COLUMNS[2].type = 'char(44)'; },
        m => { m.COLUMNS[3].collation = 'ascii_general_ci'; },
        m => { m.COLUMNS[4].defaultValue = 'login'; },
        m => { m.COLUMNS[5].type = 'int unsigned'; },
        m => { m.COLUMNS[6].nullable = 'NO'; },
        m => { m.COLUMNS[6].generationExpression = 'uuid()'; },
        m => { m.COLUMNS[7].datetimePrecision = 0; },
        m => { m.COLUMNS[7].comment = ''; },
        m => { m.COLUMNS[7].extra = 'on update CURRENT_TIMESTAMP(6)'; },
        m => { m.COLUMNS.push({ ...m.COLUMNS[2], name: 'raw_state' }); },
        m => { m.STATISTICS[0].columnName = 'user_id'; },
        m => { m.STATISTICS[1].visible = 'NO'; },
        m => { m.STATISTICS[1].indexOrder = 'D'; },
        m => { m.STATISTICS[1].indexType = 'HASH'; },
        m => { m.STATISTICS[2].nonUnique = 1; },
        m => { m.STATISTICS[2].subPart = 20; },
        m => { m.STATISTICS[3].nonUnique = 1; },
        m => { m.STATISTICS.push({ ...m.STATISTICS[3], sequence: 2, columnName: 'client_key' }); },
        m => { m.KEY_COLUMN_USAGE.length = 0; },
        m => { m.KEY_COLUMN_USAGE[0].deleteRule = 'RESTRICT'; },
        m => { m.KEY_COLUMN_USAGE[0].updateRule = 'CASCADE'; },
        m => { m.KEY_COLUMN_USAGE[0].referencedColumn = 'user_id'; },
        m => { m.KEY_COLUMN_USAGE[0].sameSchema = 0; },
        m => { m.TABLE_CONSTRAINTS[0].enforced = 'NO'; },
        m => { m.TABLE_CONSTRAINTS[1].clause = String(m.TABLE_CONSTRAINTS[1].clause).replace('> 0', '>= 0'); },
        m => { m.TABLE_CONSTRAINTS[1].clause = String(m.TABLE_CONSTRAINTS[1].clause).replace('is null', 'is not null'); },
        m => { m.TABLE_CONSTRAINTS[1].clause = String(m.TABLE_CONSTRAINTS[1].clause).replace('),0)', '),1)'); },
        m => { m.TRIGGERS.push({ name: 'restore_attempt' }); },
    ];
    for (const change of changes) {
        const metadata = fixture();
        change(metadata);
        await assert.rejects(verifyProviderAttemptSchema(source(metadata)), /reviewed schema/u);
    }
});

test('attempt user check requires the complete boolean equality, including a false NULL-link fallback', async () => {
    for (const change of [
        (clause: string) => clause.replace(' = 1)', ')'),
        (clause: string) => clause.replace(' = 1)', ' = 0)'),
        (clause: string) => clause.replace(' = 1)', ' >= 0)'),
        (clause: string) => clause.replace('),0)', '),1)'),
    ]) {
        const metadata = fixture();
        metadata.TABLE_CONSTRAINTS[1].clause = change(String(metadata.TABLE_CONSTRAINTS[1].clause));
        await assert.rejects(verifyProviderAttemptSchema(source(metadata)), /checks/u);
    }
});

test('backups may omit attempts only when 0010 was never recorded', async () => {
    await verifyOptionalProviderAttemptSchema(source(fixture(), { exists: false }));
    await assert.rejects(verifyOptionalProviderAttemptSchema(source(fixture(), {
        exists: false, recorded: true,
    })), /missing its table/u);
    const corrupt = fixture();
    corrupt.KEY_COLUMN_USAGE[0].deleteRule = 'RESTRICT';
    await assert.rejects(verifyOptionalProviderAttemptSchema(source(corrupt)), /foreign key/u);
});

test('attempt schema refuses unavailable metadata', async () => {
    await assert.rejects(verifyProviderAttemptSchema({ async query() { return [{}, []]; } }),
        /metadata is unavailable/u);
});

function extendedFixture(): Metadata {
    const metadata = fixture();
    metadata.TABLE_CONSTRAINTS[0].clause = "CAST(action AS BINARY) IN (CAST('login' AS BINARY), CAST('link' AS BINARY), "
        + "CAST('signup' AS BINARY), CAST('delete' AS BINARY))";
    metadata.TABLE_CONSTRAINTS[1].clause = "CASE WHEN CAST(action AS BINARY) IN (CAST('login' AS BINARY), CAST('signup' AS BINARY)) "
        + 'THEN user_id IS NULL ELSE COALESCE(user_id > 0, 0) END = 1';
    return metadata;
}

test('extended attempt schema accepts exactly anonymous login/signup and authenticated link/delete', async () => {
    for (const escape of ['', '\\', '\\\\']) {
        const metadata = extendedFixture();
        for (const check of metadata.TABLE_CONSTRAINTS) {
            check.clause = String(check.clause).replace(/AS BINARY/gu, 'as char charset binary')
                .replace(/'(login|link|signup|delete)'/gu, (_match, value: string) => `_utf8mb4${escape}'${value}${escape}'`);
        }
        assert.equal(await inspectProviderAttemptStage(source(metadata)), 'extended');
        await verifyProviderAttemptSchema(source(metadata), 'extended');
        await verifyOptionalProviderAttemptSchema(source(metadata, { extendedRecorded: true }));
        await assert.rejects(verifyProviderAttemptSchema(source(metadata)), /checks/u);
    }
    assert.equal(await inspectProviderAttemptStage(source()), 'legacy');
    await assert.rejects(verifyProviderAttemptSchema(source(), 'extended'), /checks/u);
});

test('readiness and replay reject missing recorded extended checks or table', async () => {
    await assert.rejects(verifyOptionalProviderAttemptSchema(source(fixture(), { extendedRecorded: true })), /missing its checks/u);
    await assert.rejects(verifyOptionalProviderAttemptSchema(source(fixture(), { exists: false, extendedRecorded: true })), /missing its table/u);
});

test('attempt stage recognition rejects mixed upgrades, changed action bytes, and permissive target checks', async () => {
    const changes: Array<(metadata: Metadata) => void> = [
        m => { m.TABLE_CONSTRAINTS[0] = fixture().TABLE_CONSTRAINTS[0]; },
        m => { m.TABLE_CONSTRAINTS[1] = fixture().TABLE_CONSTRAINTS[1]; },
        m => { m.TABLE_CONSTRAINTS[1].enforced = 'NO'; },
        m => { m.TABLE_CONSTRAINTS[0].clause = String(m.TABLE_CONSTRAINTS[0].clause).replace('signup', 'SIGNUP'); },
        m => { m.TABLE_CONSTRAINTS[1].clause = String(m.TABLE_CONSTRAINTS[1].clause).replace('signup', 'delete'); },
        m => { m.TABLE_CONSTRAINTS[1].clause = String(m.TABLE_CONSTRAINTS[1].clause).replace('> 0, 0', '> 0, 1'); },
        m => { m.TABLE_CONSTRAINTS[1].clause = String(m.TABLE_CONSTRAINTS[1].clause).replace('= 1', '>= 0'); },
        m => { m.TABLE_CONSTRAINTS[0].clause = String(m.TABLE_CONSTRAINTS[0].clause) + ' OR TRUE'; },
    ];
    for (const change of changes) {
        const metadata = extendedFixture(); change(metadata);
        await assert.rejects(inspectProviderAttemptStage(source(metadata)), /checks/u);
        await assert.rejects(verifyOptionalProviderAttemptSchema(source(metadata)), /checks/u);
    }
});
