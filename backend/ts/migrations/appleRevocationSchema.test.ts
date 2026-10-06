import assert from 'node:assert/strict';
import test from 'node:test';
import * as sessions from './accountSessionSchema';
import { APPLE_REVOCATION_MIGRATION_VERSION, verifyAppleRevocationSchema, verifyAppleRevocationReadiness,
    verifyOptionalAppleRevocationSchema } from './appleRevocationSchema';
import type { MigrationConnection } from './leaderboardSchema';

function fixture() {
    const column = (name: string, type: string, datetimePrecision: number | null = null, comment = '') => ({
        name, type, nullable: 'NO', characterSet: null, collation: null, defaultValue: null, extra: '',
        datetimePrecision, comment, generationExpression: '',
    });
    const index = (name: string, columnName: string, nonUnique = 1, sequence = 1) => ({
        name, sequence, columnName, nonUnique, indexOrder: 'A', subPart: null, visible: 'YES', indexType: 'BTREE',
    });
    return {
        table: [{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', tableType: 'BASE TABLE' }],
        columns: [column('subject_hash', 'binary(32)'), column('revoked_at', 'bigint unsigned'),
            column('expires_at', 'datetime(6)', 6, 'UTC')],
        indexes: [index('idx_apple_revocations_expiry', 'expires_at'), index('idx_apple_revocations_expiry', 'subject_hash', 1, 2),
            index('PRIMARY', 'subject_hash', 0)],
        foreignKeys: [] as object[], checks: [] as object[], triggers: [] as object[],
    };
}

function source(metadata = fixture(), exists = true, recorded = [APPLE_REVOCATION_MIGRATION_VERSION,
    sessions.APPLE_SESSION_PROVENANCE_MIGRATION_VERSION]): MigrationConnection {
    return { async query(sql, values) {
        if (sql.includes('schema_migrations')) return [recorded.filter(version => values?.includes(version)).map(version => ({ version })), []];
        assert.deepEqual(values, ['apple_auth_revocations']);
        if (sql.includes('COUNT(*)')) return [[{ tableCount: exists ? 1 : 0 }], []];
        return [sql.includes('information_schema.COLUMNS') ? metadata.columns
            : sql.includes('information_schema.STATISTICS') ? metadata.indexes
                : sql.includes("CONSTRAINT_TYPE = 'FOREIGN KEY'") ? metadata.foreignKeys
                    : sql.includes("CONSTRAINT_TYPE = 'CHECK'") ? metadata.checks
                        : sql.includes('information_schema.TRIGGERS') ? metadata.triggers : metadata.table, []];
    } };
}

test('Apple revocation watermark stores only hashed subject, signed epoch and indexed UTC expiry', async () => {
    await verifyAppleRevocationSchema(source());
    await verifyOptionalAppleRevocationSchema(source());
    for (const mutate of [
        (data: ReturnType<typeof fixture>) => { data.table[0].engine = 'MyISAM'; },
        (data: ReturnType<typeof fixture>) => { data.columns[0].type = 'varchar(255)'; },
        (data: ReturnType<typeof fixture>) => { data.columns[1].nullable = 'YES'; },
        (data: ReturnType<typeof fixture>) => { data.columns[2].comment = ''; },
        (data: ReturnType<typeof fixture>) => { data.indexes[0].visible = 'NO'; },
        (data: ReturnType<typeof fixture>) => { data.foreignKeys.push({ name: 'account_cascade' }); },
        (data: ReturnType<typeof fixture>) => { data.checks.push({ name: 'unexpected' }); },
        (data: ReturnType<typeof fixture>) => { data.triggers.push({ name: 'notification_history' }); },
    ]) {
        const metadata = fixture(); mutate(metadata);
        await assert.rejects(verifyAppleRevocationSchema(source(metadata)), /reviewed schema/u);
    }
});

test('historical backups may omit the watermark, but recorded missing storage fails closed', async () => {
    await verifyOptionalAppleRevocationSchema(source(fixture(), false, []));
    await assert.rejects(verifyOptionalAppleRevocationSchema(source(fixture(), false)), /missing its table/u);
    await assert.rejects(verifyAppleRevocationSchema({ async query() { return [{}, []]; } }), /metadata is unavailable/u);
});

test('readiness requires both recorded migrations and the exact provenance session stage', async context => {
    const connection = source();
    const verify = context.mock.method(sessions, 'verifyAccountSessionSchema', async (...args: unknown[]) => {
        assert.deepEqual(args, [connection, true, true]);
    });
    await verifyAppleRevocationReadiness(connection);
    assert.equal(verify.mock.callCount(), 1);
    for (const missing of [[], [APPLE_REVOCATION_MIGRATION_VERSION], [sessions.APPLE_SESSION_PROVENANCE_MIGRATION_VERSION]]) {
        await assert.rejects(verifyAppleRevocationReadiness(source(fixture(), true, missing)), /both recorded migrations/u);
    }
    verify.mock.mockImplementation(async () => { throw new Error('provenance incomplete'); });
    await assert.rejects(verifyAppleRevocationReadiness(source()), /provenance incomplete/u);
});
