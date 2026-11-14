import assert from 'node:assert/strict';
import test from 'node:test';
import type { MigrationConnection } from './leaderboardSchema';
import { inspectUniqueUserNames, inspectPasswordlessAccounts, verifyUniqueUserNamesPrecondition,
    verifyUniqueUserNamesSchema, verifyPasswordlessAccountsPrecondition,
    verifyPasswordlessAccountSchema } from './passwordlessAccountSchema';

type Metadata = { table: Record<string, unknown>[]; name: Record<string, unknown>[];
    password: Record<string, unknown>[]; indexes: Record<string, unknown>[]; duplicates: Record<string, unknown>[] };

function fixture(unique = false, passwordless = false): Metadata {
    const column = (nullable: string) => ({ type: 'varchar(255)', nullable,
        characterSet: 'utf8mb4', collation: 'utf8mb4_unicode_ci', defaultValue: null,
        extra: '', comment: '', generationExpression: '' });
    return {
        table: [{ engine: 'InnoDB', tableType: 'BASE TABLE' }], name: [column('NO')],
        password: [column(passwordless ? 'YES' : 'NO')],
        indexes: unique ? [{ columnName: 'user_name', nonUnique: 0, sequence: 1, indexOrder: 'A',
            subPart: null, visible: 'YES', indexType: 'BTREE' }] : [], duplicates: [],
    };
}

function source(metadata = fixture()) {
    const queries: string[] = [];
    const connection: MigrationConnection = { async query(sql, values) {
        queries.push(sql);
        if (sql.includes('information_schema.TABLES')) return [metadata.table, []];
        if (sql.includes('information_schema.COLUMNS')) return [values?.[0] === 'user_name' ? metadata.name : metadata.password, []];
        if (sql.includes('information_schema.STATISTICS')) return [metadata.indexes, []];
        if (sql.includes('GROUP BY user_name HAVING COUNT(*) > 1 LIMIT 1')) return [metadata.duplicates, []];
        throw new Error('Unexpected passwordless schema query');
    } };
    return { connection, queries };
}

test('username preflight uses existing collation, detects duplicates, and never changes account data', async () => {
    const clean = source();
    await verifyUniqueUserNamesPrecondition(clean.connection);
    assert.ok(clean.queries.some(sql => /GROUP BY user_name HAVING COUNT\(\*\) > 1 LIMIT 1/u.test(sql)));
    assert.ok(clean.queries.every(sql => /^SELECT/u.test(sql.trim())));
    const duplicate = fixture(); duplicate.duplicates = [{ duplicateFound: 1 }];
    await assert.rejects(verifyUniqueUserNamesPrecondition(source(duplicate).connection),
        /duplicate user names require explicit resolution/u);
});

test('credential migration stages are strict and nullable password readiness also requires username uniqueness', async () => {
    assert.equal(await inspectUniqueUserNames(source().connection), false);
    assert.equal(await inspectPasswordlessAccounts(source().connection), false);
    await assert.rejects(verifyUniqueUserNamesSchema(source().connection), /unique index is missing/u);
    await verifyUniqueUserNamesSchema(source(fixture(true)).connection);
    await assert.rejects(verifyUniqueUserNamesPrecondition(source(fixture(true)).connection), /already present/u);
    await assert.rejects(verifyPasswordlessAccountsPrecondition(source().connection), /unique index is missing/u);
    await verifyPasswordlessAccountsPrecondition(source(fixture(true)).connection);
    await assert.rejects(verifyPasswordlessAccountSchema(source(fixture(true)).connection), /nullable password column is missing/u);
    await verifyPasswordlessAccountSchema(source(fixture(true, true)).connection);
    await assert.rejects(verifyPasswordlessAccountsPrecondition(source(fixture(true, true)).connection), /already present/u);
});

test('username uniqueness rejects nullable names, changed collation, partial or composite indexes and schema drift', async () => {
    const changes: Array<(m: Metadata) => void> = [
        m => { m.table[0].engine = 'MyISAM'; }, m => { m.table[0].tableType = 'VIEW'; },
        m => { m.name.length = 0; }, m => { m.name[0].nullable = 'YES'; },
        m => { m.name[0].type = 'varchar(128)'; }, m => { m.name[0].collation = 'utf8mb4_bin'; },
        m => { m.name[0].defaultValue = ''; }, m => { m.name[0].generationExpression = 'lower(email)'; },
        m => { m.indexes[0].nonUnique = 1; }, m => { m.indexes[0].visible = 'NO'; },
        m => { m.indexes[0].columnName = 'email'; }, m => { m.indexes[0].subPart = 64; },
        m => { m.indexes[0].indexOrder = 'D'; }, m => { m.indexes[0].indexType = 'HASH'; },
        m => { m.indexes.push({ ...m.indexes[0], sequence: 2, columnName: 'email' }); },
    ];
    for (const change of changes) {
        const metadata = fixture(true); change(metadata);
        await assert.rejects(inspectUniqueUserNames(source(metadata).connection), /reviewed schema/u);
    }
});

test('password nullability is the only allowed column change and unknown metadata fails closed', async () => {
    for (const [key, value] of Object.entries({ type: 'text', nullable: 'UNKNOWN', characterSet: 'ascii',
        collation: 'utf8mb4_bin', defaultValue: '', extra: 'DEFAULT_GENERATED', comment: 'changed', generationExpression: 'uuid()' })) {
        const metadata = fixture(true, true); metadata.password[0][key] = value;
        await assert.rejects(verifyPasswordlessAccountSchema(source(metadata).connection), /reviewed schema/u);
    }
    await assert.rejects(inspectPasswordlessAccounts({ async query() { return [{}, []]; } }), /metadata is unavailable/u);
});
