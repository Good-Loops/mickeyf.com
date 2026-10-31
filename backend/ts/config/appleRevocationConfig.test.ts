import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import type { PoolConnection, QueryOptions } from 'mysql2/promise';
import { verifyAppleRevocationConnection } from '../accounts/runAppleTokenRevocation';
import { loadAppleRevocationConfig, loadAppleRevocationLifecycle } from './appleRevocationConfig';

const environment = {
    NODE_ENV: 'production', APPLE_REVOCATION_RUN_ENABLED: 'true', APPLE_TOKEN_LIFECYCLE_ENABLED: 'true',
    APPLE_REVOCATION_DB_USER: 'cms_mickeyf', APPLE_REVOCATION_DB_PASS: 'synthetic-password', APPLE_REVOCATION_DB_NAME: 'cms',
    APPLE_REVOCATION_CLOUD_SQL_CONNECTION_NAME: 'noted-reef-387021:us-central1:cms-mickeyf',
    APPLE_REVOCATION_EXPECTED_ACCOUNT: 'cms_mickeyf@%', APPLE_REVOCATION_EXPECTED_SERVER_UUID: '11111111-2222-3333-4444-555555555555',
    APPLE_IOS_BUNDLE_ID: 'com.example.test', APPLE_SIGN_IN_TEAM_ID: 'ABCDEFGHIJ', APPLE_SIGN_IN_KEY_ID: '0123456789',
    APPLE_SIGN_IN_PRIVATE_KEY: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
        .export({ format: 'pem', type: 'pkcs8' }).toString(),
    APPLE_TOKEN_ACTIVE_KEY_ID: 'v1', APPLE_TOKEN_ENCRYPTION_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 9).toString('base64') }),
};

test('explicit apply constructs only the reviewed production socket config', () => {
    const config = loadAppleRevocationConfig(['apply'], environment);
    assert.deepEqual(config.databaseOptions, {
        user: 'cms_mickeyf', password: 'synthetic-password', database: 'cms',
        socketPath: '/cloudsql/noted-reef-387021:us-central1:cms-mickeyf',
        connectionLimit: 1, waitForConnections: false, queueLimit: 0, connectTimeout: 10_000,
        multipleStatements: false, timezone: 'Z', dateStrings: true,
    });
    assert.equal(config.expectedAccount, environment.APPLE_REVOCATION_EXPECTED_ACCOUNT);
    assert.equal(config.expectedServerUuid, environment.APPLE_REVOCATION_EXPECTED_SERVER_UUID);
    assert.equal('lifecycle' in config, false);
    assert.equal(Object.isFrozen(config), true);
    assert.equal(loadAppleRevocationLifecycle(environment).clientId, environment.APPLE_IOS_BUNDLE_ID);
});

test('unknown commands, implicit activation, nonproduction and isolated runtimes are rejected', () => {
    for (const args of [[], ['plan'], ['apply', 'extra'], ['APPLY']]) {
        assert.throws(() => loadAppleRevocationConfig(args, {}), /Usage/u);
    }
    for (const change of [
        ...[undefined, 'false', 'TRUE', '1', 'true\n'].map(APPLE_REVOCATION_RUN_ENABLED => ({ APPLE_REVOCATION_RUN_ENABLED })),
        ...[undefined, 'development', 'test', 'production\n'].map(NODE_ENV => ({ NODE_ENV })),
        ...['true', 'TRUE', '1', ''].map(LUDOLUME_ISOLATED_RUNTIME => ({ LUDOLUME_ISOLATED_RUNTIME })),
    ]) assert.throws(() => loadAppleRevocationConfig(['apply'], { ...environment, ...change }));
});

test('every explicit DB confirmation is required and website credentials never act as defaults', () => {
    for (const name of ['APPLE_REVOCATION_DB_USER', 'APPLE_REVOCATION_DB_PASS', 'APPLE_REVOCATION_DB_NAME',
        'APPLE_REVOCATION_CLOUD_SQL_CONNECTION_NAME', 'APPLE_REVOCATION_EXPECTED_ACCOUNT', 'APPLE_REVOCATION_EXPECTED_SERVER_UUID']) {
        assert.throws(() => loadAppleRevocationConfig(['apply'], { ...environment, [name]: undefined,
            DB_USER: 'cms_mickeyf', DB_PASS: 'private fallback', DB_NAME: 'cms',
            CLOUD_SQL_CONNECTION_NAME: environment.APPLE_REVOCATION_CLOUD_SQL_CONNECTION_NAME }));
    }
    for (const change of [
        { APPLE_REVOCATION_DB_USER: 'root' }, { APPLE_REVOCATION_DB_NAME: 'cms-copy' },
        { APPLE_REVOCATION_EXPECTED_ACCOUNT: 'cms_mickeyf@localhost' },
        { APPLE_REVOCATION_CLOUD_SQL_CONNECTION_NAME: 'other:us-central1:cms-mickeyf' },
        { APPLE_REVOCATION_EXPECTED_SERVER_UUID: `${environment.APPLE_REVOCATION_EXPECTED_SERVER_UUID}\n` },
        { APPLE_REVOCATION_DB_HOST: '127.0.0.1' }, { APPLE_REVOCATION_DB_PORT: '3306' },
    ]) {
        assert.throws(() => loadAppleRevocationConfig(['apply'], { ...environment, ...change }), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.doesNotMatch(error.message, /private-invalid|synthetic-password/u);
            assert.equal('cause' in error, false);
            return true;
        });
    }
});

test('disabled or malformed retry credentials cannot block DB configuration but fail strict lifecycle parsing', () => {
    for (const change of [
        ...[undefined, 'false', 'TRUE'].map(APPLE_TOKEN_LIFECYCLE_ENABLED => ({ APPLE_TOKEN_LIFECYCLE_ENABLED })),
        { APPLE_SIGN_IN_PRIVATE_KEY: 'private-invalid-material' }, { APPLE_TOKEN_ENCRYPTION_KEYS: 'private-invalid-json' },
    ]) {
        const env = { ...environment, ...change };
        assert.equal(loadAppleRevocationConfig(['apply'], env).expectedAccount, environment.APPLE_REVOCATION_EXPECTED_ACCOUNT);
        assert.throws(() => loadAppleRevocationLifecycle(env), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.doesNotMatch(error.message, /private-invalid|synthetic-password/u);
            assert.equal('cause' in error, false);
            return true;
        });
    }
});

test('connection identity mismatches fail before schema queries, locks, writes or Apple calls', async () => {
    const config = loadAppleRevocationConfig(['apply'], environment);
    const target = { databaseName: 'cms', currentUser: config.expectedAccount, serverUuid: config.expectedServerUuid };
    for (const result of [[], [target, target], [{ ...target, databaseName: 'cms-copy' }],
        [{ ...target, currentUser: 'root@%' }], [{ ...target, serverUuid: 'wrong-instance' }]]) {
        let queries = 0;
        const connection = { async query(input: QueryOptions) {
            queries++;
            assert.match(input.sql, /^SELECT DATABASE\(\)/u);
            assert.equal(input.timeout, 10_000);
            return [result, []];
        } } as unknown as PoolConnection;
        await assert.rejects(verifyAppleRevocationConnection(connection, config), /could not be verified/u);
        assert.equal(queries, 1);
    }
});

test('matching identity still requires recorded 0016 and the exact reviewed table before any mutation', async () => {
    const config = loadAppleRevocationConfig(['apply'], environment);
    for (const recorded of [false, true]) {
        const queries: string[] = [];
        const connection = { async query(input: QueryOptions) {
            queries.push(input.sql);
            assert.match(input.sql, /^SELECT/u);
            assert.equal(input.timeout, 10_000);
            if (input.sql.includes('CURRENT_USER')) return [[{ databaseName: 'cms',
                currentUser: config.expectedAccount, serverUuid: config.expectedServerUuid }], []];
            if (input.sql.includes('schema_migrations')) return [recorded ? [{ version: '0016_create_apple_provider_tokens' }] : [], []];
            return [[{ engine: 'MyISAM', collation: 'utf8mb4_unicode_ci', tableType: 'BASE TABLE' }], []];
        } } as unknown as PoolConnection;
        await assert.rejects(verifyAppleRevocationConnection(connection, config), /could not be verified/u);
        assert.equal(queries.length, recorded ? 3 : 2);
    }
});
