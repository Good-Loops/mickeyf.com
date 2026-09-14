import assert from 'node:assert/strict';
import test from 'node:test';
import type { MigrationConnection } from './leaderboardSchema';
import { ACCOUNT_SESSION_MIGRATION_VERSION, verifyAccountSessionSchema, verifyOptionalAccountSessionSchema } from './accountSessionSchema';

type Metadata = Record<string, Array<Record<string, unknown>>>;
function fixture(): Metadata {
    const column = (name: string, type: string, characterSet: string | null = null,
        collation: string | null = null, datetimePrecision: number | null = null, comment = '') => ({
        name, type, nullable: 'NO', characterSet, collation, defaultValue: null, extra: '',
        datetimePrecision, comment, generationExpression: '',
    });
    const index = (name: string, columnName: string, nonUnique: number, sequence = 1) => ({
        name, sequence, columnName, nonUnique, indexOrder: 'A', subPart: null, visible: 'YES', indexType: 'BTREE',
    });
    return {
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
}
function source(metadata = fixture(), options: { exists?: boolean; recorded?: boolean } = {}): MigrationConnection {
    return { async query(sql, values) {
        if (sql.includes('COUNT(*)') && sql.includes('information_schema.TABLES')) {
            assert.deepEqual(values, ['account_sessions']);
            return [[{ tableCount: options.exists === false ? 0 : 1 }], []];
        }
        if (sql.includes('FROM schema_migrations')) {
            assert.deepEqual(values, [ACCOUNT_SESSION_MIGRATION_VERSION]);
            return [options.recorded ? [{ version: ACCOUNT_SESSION_MIGRATION_VERSION }] : [], []];
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
