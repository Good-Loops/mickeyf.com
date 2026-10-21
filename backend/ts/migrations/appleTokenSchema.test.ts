import assert from 'node:assert/strict';
import test from 'node:test';
import { APPLE_TOKEN_MIGRATION_VERSION, verifyAppleTokenSchema, verifyAppleTokenReadiness,
    verifyOptionalAppleTokenSchema } from './appleTokenSchema';
import type { MigrationConnection } from './leaderboardSchema';

function fixture() {
    const column = (name: string, type: string, characterSet: string | null = null, collation: string | null = null,
        nullable = 'NO', defaultValue: string | null = null, datetimePrecision: number | null = null, comment = '') => ({
        name, type, nullable, characterSet, collation, defaultValue, extra: '', datetimePrecision, comment, generationExpression: '',
    });
    const index = (name: string, columnName: string, nonUnique = 1, sequence = 1) => ({
        name, sequence, columnName, nonUnique, indexOrder: 'A', subPart: null, visible: 'YES', indexType: 'BTREE',
    });
    return {
        table: [{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', tableType: 'BASE TABLE' }],
        columns: [column('token_id', 'char(36)', 'ascii', 'ascii_bin'), column('account_uuid', 'char(36)', 'ascii', 'ascii_bin'),
            column('client_id', 'varchar(255)', 'ascii', 'ascii_bin'), column('encrypted_token', 'varbinary(8192)'),
            ...['created_at', 'revocation_requested_at', 'next_attempt_at', 'retention_deadline'].map(name =>
                column(name, 'datetime(6)', null, null, name === 'created_at' ? 'NO' : 'YES', null, 6, 'UTC')),
            column('attempt_count', 'int unsigned', null, null, 'NO', '0')],
        indexes: [index('idx_apple_tokens_account', 'account_uuid'), index('idx_apple_tokens_retention', 'retention_deadline'),
            index('idx_apple_tokens_retry', 'next_attempt_at'), index('idx_apple_tokens_retry', 'token_id', 1, 2),
            index('PRIMARY', 'token_id', 0)],
        foreignKeys: [] as object[], triggers: [] as object[], checks: [] as object[],
    };
}

function source(metadata = fixture(), exists = true, recorded = true): MigrationConnection {
    return { async query(sql) {
        if (sql.includes('schema_migrations')) return [recorded ? [{ version: APPLE_TOKEN_MIGRATION_VERSION }] : [], []];
        if (sql.includes('COUNT(*)')) return [[{ tableCount: exists ? 1 : 0 }], []];
        const result = sql.includes('information_schema.COLUMNS') ? metadata.columns
            : sql.includes('information_schema.STATISTICS') ? metadata.indexes
                : sql.includes("CONSTRAINT_TYPE = 'FOREIGN KEY'") ? metadata.foreignKeys
                    : sql.includes("CONSTRAINT_TYPE = 'CHECK'") ? metadata.checks
                        : sql.includes('information_schema.TRIGGERS') ? metadata.triggers : metadata.table;
        return [result, []];
    } };
}

test('exact Apple token storage has bounded binary envelopes, retry indexes and no cascading relationship', async () => {
    await verifyAppleTokenSchema(source());
    await verifyAppleTokenReadiness(source());
    for (const change of [
        (data: ReturnType<typeof fixture>) => { data.foreignKeys.push({ name: 'cascade' }); },
        (data: ReturnType<typeof fixture>) => { data.columns[3].type = 'text'; },
        (data: ReturnType<typeof fixture>) => { data.columns[7].nullable = 'NO'; },
        (data: ReturnType<typeof fixture>) => { data.indexes.pop(); },
        (data: ReturnType<typeof fixture>) => { data.triggers.push({ name: 'hidden-write' }); },
    ]) {
        const invalid = fixture(); change(invalid);
        await assert.rejects(verifyAppleTokenSchema(source(invalid)), /reviewed schema/u);
    }
});

test('only historical unrecorded backups may omit storage; enabled Apple always requires recorded history', async () => {
    await verifyOptionalAppleTokenSchema(source(fixture(), false, false));
    await assert.rejects(verifyOptionalAppleTokenSchema(source(fixture(), false, true)), /missing its table/u);
    await assert.rejects(verifyAppleTokenReadiness(source(fixture(), true, false)), /recorded migration/u);
});
