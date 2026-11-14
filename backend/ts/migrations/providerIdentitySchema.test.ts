import assert from 'node:assert/strict';
import test from 'node:test';
import type { MigrationConnection } from './leaderboardSchema';
import { verifyOptionalProviderIdentitySchema, verifyProviderIdentitySchema } from './providerIdentitySchema';

type Metadata = Record<string, Array<Record<string, unknown>>>;

function fixture(): Metadata {
    const column = (name: string, type: string, characterSet: string | null = null,
        collation: string | null = null, datetimePrecision: number | null = null, comment = '') => ({
        name, type, nullable: 'NO', characterSet, collation, defaultValue: null, extra: '',
        datetimePrecision, comment, generationExpression: '',
    });
    const index = (name: string, sequence: number, columnName: string) => ({
        name, sequence, columnName, nonUnique: 0, indexOrder: 'A', subPart: null, visible: 'YES', indexType: 'BTREE',
    });
    return {
        TABLES: [{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', tableType: 'BASE TABLE' }],
        COLUMNS: [column('account_uuid', 'char(36)', 'ascii', 'ascii_bin'),
            column('provider', 'varchar(16)', 'ascii', 'ascii_bin'), column('subject', 'varbinary(255)'),
            column('linked_at', 'datetime(6)', null, null, 6, 'UTC')],
        STATISTICS: [index('PRIMARY', 1, 'provider'), index('PRIMARY', 2, 'subject'),
            index('uq_account_provider_identity', 1, 'account_uuid'), index('uq_account_provider_identity', 2, 'provider')],
        KEY_COLUMN_USAGE: [{ name: 'fk_account_provider_identity_account', sequence: 1, columnName: 'account_uuid',
            referencedTable: 'users', referencedColumn: 'account_uuid', sameSchema: 1,
            deleteRule: 'CASCADE', updateRule: 'RESTRICT' }],
        TABLE_CONSTRAINTS: [{ name: 'chk_account_provider_identity_provider',
            clause: "(cast(`provider` as binary) in (cast(_utf8mb4'google' as binary),cast(_utf8mb4'apple' as binary)))", enforced: 'YES' },
        { name: 'chk_account_provider_identity_subject', clause: '(octet_length(`subject`) between 1 and 255)', enforced: 'YES' }],
        TRIGGERS: [],
    };
}

function source(metadata = fixture(), options: { exists?: boolean; recorded?: boolean } = {}): MigrationConnection {
    return { async query(sql) {
        if (sql.includes('COUNT(*)') && sql.includes('information_schema.TABLES')) {
            return [[{ tableCount: options.exists === false ? 0 : 1 }], []];
        }
        if (sql.includes('FROM schema_migrations')) return [options.recorded ? [{ version: '0009' }] : [], []];
        const category = /FROM information_schema\.([A-Z_]+)/u.exec(sql)?.[1];
        if (!category || !metadata[category]) throw new Error('Unexpected schema metadata query');
        return [metadata[category], []];
    } };
}

test('provider schema accepts exact UUID cascade, opaque subjects, and provider constraints', async () => {
    await verifyProviderIdentitySchema(source());
    await verifyOptionalProviderIdentitySchema(source());
});

test('provider checks accept MySQL 8.0.31 binary casts, length alias, and escaped metadata delimiters', async () => {
    for (const escape of ['', '\\', '\\\\']) {
        const metadata = fixture();
        const literal = (value: string) => `_utf8mb4${escape}'${value}${escape}'`;
        metadata.TABLE_CONSTRAINTS[0].clause = `(cast(\`provider\` as char charset binary) in `
            + `(cast(${literal('google')} as char charset binary),cast(${literal('apple')} as char charset binary)))`;
        metadata.TABLE_CONSTRAINTS[1].clause = '(length(`subject`) between 1 and 255)';
        await verifyProviderIdentitySchema(source(metadata));
        const exactClause = String(metadata.TABLE_CONSTRAINTS[0].clause);
        for (const invalidClause of [
            exactClause.replace('google', 'GOOGLE'),
            exactClause.replace('google', 'google '),
            exactClause.replace('google', 'goo\\gle'),
            exactClause.replace(`google${escape}'`, `google\\${escape}'`),
            `${exactClause} OR TRUE`,
            exactClause.replace('as char charset binary', 'as char'),
        ]) {
            metadata.TABLE_CONSTRAINTS[0].clause = invalidClause;
            await assert.rejects(verifyProviderIdentitySchema(source(metadata)), /checks/u);
        }
    }
});

test('provider schema rejects altered identity, uniqueness, ownership, and lifecycle guarantees', async () => {
    const changes: Array<(metadata: Metadata) => void> = [
        m => { m.TABLES[0].engine = 'MyISAM'; },
        m => { m.TABLES[0].tableType = 'VIEW'; },
        m => { m.COLUMNS[0].collation = 'ascii_general_ci'; },
        m => { m.COLUMNS[2].type = 'varchar(255)'; },
        m => { m.COLUMNS[2].nullable = 'YES'; },
        m => { m.COLUMNS[2].generationExpression = 'lower(provider)'; },
        m => { m.COLUMNS.push({ ...m.COLUMNS[2], name: 'access_token' }); },
        m => { m.STATISTICS[1].subPart = 20; },
        m => { m.STATISTICS[2].nonUnique = 1; },
        m => { m.STATISTICS[2].visible = 'NO'; },
        m => { m.STATISTICS[3].columnName = 'subject'; },
        m => { m.KEY_COLUMN_USAGE.length = 0; },
        m => { m.KEY_COLUMN_USAGE[0].deleteRule = 'RESTRICT'; },
        m => { m.KEY_COLUMN_USAGE[0].updateRule = 'CASCADE'; },
        m => { m.KEY_COLUMN_USAGE[0].referencedColumn = 'user_id'; },
        m => { m.KEY_COLUMN_USAGE[0].sameSchema = 0; },
        m => { m.TABLE_CONSTRAINTS[0].enforced = 'NO'; },
        m => { m.TABLE_CONSTRAINTS[0].clause = String(m.TABLE_CONSTRAINTS[0].clause).replace('google', 'GOOGLE'); },
        m => { m.TABLE_CONSTRAINTS[0].clause = String(m.TABLE_CONSTRAINTS[0].clause).replace('google', 'google '); },
        m => { m.TABLE_CONSTRAINTS[1].clause = 'octet_length(subject) between 0 and 255'; },
        m => { m.TRIGGERS.push({ name: 'restore_link' }); },
    ];
    for (const change of changes) {
        const metadata = fixture();
        change(metadata);
        await assert.rejects(verifyProviderIdentitySchema(source(metadata)), /reviewed schema/u);
    }
});

test('old backups may omit provider identities only when 0009 was never recorded', async () => {
    await verifyOptionalProviderIdentitySchema(source(fixture(), { exists: false }));
    await assert.rejects(verifyOptionalProviderIdentitySchema(source(fixture(), {
        exists: false, recorded: true,
    })), /missing its table/u);
    const corrupt = fixture();
    corrupt.KEY_COLUMN_USAGE[0].deleteRule = 'RESTRICT';
    await assert.rejects(verifyOptionalProviderIdentitySchema(source(corrupt)), /foreign key/u);
});
