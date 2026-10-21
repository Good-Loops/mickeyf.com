import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDeletionAuditConfig } from './deletionAuditConfig';

const ENV = {
    NODE_ENV: 'test',
    DELETION_AUDIT_DB_USER: 'audit_test',
    DELETION_AUDIT_DB_PASSWORD: ' test-only-password ',
    DELETION_AUDIT_DB_NAME: 'audit_test',
    DELETION_AUDIT_DB_HOST: '127.0.0.1',
    DELETION_AUDIT_DB_PORT: '3317',
    DELETION_AUDIT_DB_CURRENT_USER: 'audit_test@cloudsqlproxy~%',
    DELETION_AUDIT_DB_SERVER_UUID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    DELETION_AUDIT_IDENTITY_EPOCH: '2026-09-12 00:15:39.954172',
};

test('loads dedicated local audit pins, bounded pool and UTC without a freeze acknowledgement', () => {
    const config = loadDeletionAuditConfig(ENV);
    assert.deepEqual(config.databaseOptions, {
        host: '127.0.0.1', port: 3317, user: 'audit_test', password: ' test-only-password ', database: 'audit_test',
        connectionLimit: 1, waitForConnections: false, queueLimit: 0, connectTimeout: 10000,
        timezone: 'Z', dateStrings: true, multipleStatements: false,
    });
    assert.deepEqual(config.settings, {
        database: 'audit_test', expectedCurrentUser: ENV.DELETION_AUDIT_DB_CURRENT_USER,
        expectedServerUuid: ENV.DELETION_AUDIT_DB_SERVER_UUID,
        expectedIdentityEpoch: ENV.DELETION_AUDIT_IDENTITY_EPOCH,
        graceMs: 900000, maxIntents: 1000, maxDurationMs: 60000,
    });
});

test('requires explicit environment and dedicated credentials and pins with no website fallbacks', () => {
    for (const name of Object.keys(ENV)) {
        assert.throws(() => loadDeletionAuditConfig({
            ...ENV, [name]: undefined,
            DB_USER: 'website', DB_PASS: 'website-password', DB_NAME: 'cms', DB_HOST: '127.0.0.1', DB_PORT: '3306',
        }));
    }
    assert.throws(() => loadDeletionAuditConfig({ ...ENV, NODE_ENV: 'staging' }));
});

test('rejects arbitrary local targets, malformed identities and non-calendar epochs', () => {
    for (const change of [
        { DELETION_AUDIT_DB_HOST: 'localhost' },
        { DELETION_AUDIT_DB_HOST: '192.168.0.10' },
        { DELETION_AUDIT_DB_PORT: '65536' },
        { DELETION_AUDIT_DB_PORT: '3306.5' },
        { DELETION_AUDIT_CLOUD_SQL_CONNECTION_NAME: 'other:region:instance' },
        { DELETION_AUDIT_DB_USER: 'audit~test' },
        { DELETION_AUDIT_DB_NAME: 'cms; DROP' },
        { DELETION_AUDIT_DB_CURRENT_USER: 'another@cloudsqlproxy~%' },
        { DELETION_AUDIT_DB_CURRENT_USER: 'audit_test@cloudsqlproxy~%;' },
        { DELETION_AUDIT_DB_SERVER_UUID: 'not-a-uuid' },
        { DELETION_AUDIT_IDENTITY_EPOCH: '2026-09-12 00:15:39' },
        { DELETION_AUDIT_IDENTITY_EPOCH: '2026-02-30 00:15:39.954172' },
        { DELETION_AUDIT_IDENTITY_EPOCH: '2026-09-12 24:15:39.954172' },
    ]) assert.throws(() => loadDeletionAuditConfig({ ...ENV, ...change }));
});

test('production requires the exact database, proxy-only audit user and fixed Cloud SQL socket', () => {
    const production = {
        ...ENV, NODE_ENV: 'production', DELETION_AUDIT_DB_USER: 'deletion_audit', DELETION_AUDIT_DB_NAME: 'cms',
        DELETION_AUDIT_DB_CURRENT_USER: 'deletion_audit@cloudsqlproxy~%',
        DELETION_AUDIT_CLOUD_SQL_CONNECTION_NAME: 'noted-reef-387021:us-central1:cms-mickeyf',
        DELETION_AUDIT_DB_HOST: undefined, DELETION_AUDIT_DB_PORT: undefined,
    };
    const config = loadDeletionAuditConfig(production);
    assert.equal(config.databaseOptions.socketPath, '/cloudsql/noted-reef-387021:us-central1:cms-mickeyf');
    assert.equal(config.databaseOptions.host, undefined);
    assert.equal(config.databaseOptions.port, undefined);
    for (const change of [
        { DELETION_AUDIT_CLOUD_SQL_CONNECTION_NAME: undefined },
        { DELETION_AUDIT_CLOUD_SQL_CONNECTION_NAME: 'noted-reef-387021:us-central1:another-instance' },
        { DELETION_AUDIT_DB_USER: 'cms_mickeyf', DELETION_AUDIT_DB_CURRENT_USER: 'cms_mickeyf@%' },
        { DELETION_AUDIT_DB_CURRENT_USER: 'deletion_audit@%' },
        { DELETION_AUDIT_DB_NAME: 'another_database' },
        { DELETION_AUDIT_DB_HOST: '127.0.0.1' },
        { DELETION_AUDIT_DB_HOST: '' },
        { DELETION_AUDIT_DB_PORT: '3306' },
    ]) assert.throws(() => loadDeletionAuditConfig({ ...production, ...change }));
});

test('enforces positive bounded grace, journal count and duration without unbounded connection acquisition', () => {
    const config = loadDeletionAuditConfig({
        ...ENV, DELETION_AUDIT_GRACE_MS: '86400000', DELETION_AUDIT_MAX_INTENTS: '10000',
        DELETION_AUDIT_MAX_DURATION_MS: '100',
    });
    assert.equal(config.settings.graceMs, 86400000);
    assert.equal(config.settings.maxIntents, 10000);
    assert.equal(config.settings.maxDurationMs, 100);
    assert.equal(config.databaseOptions.connectTimeout, 100);
    for (const change of [
        { DELETION_AUDIT_GRACE_MS: '0' }, { DELETION_AUDIT_GRACE_MS: '86400001' },
        { DELETION_AUDIT_MAX_INTENTS: '-1' }, { DELETION_AUDIT_MAX_INTENTS: '10001' },
        { DELETION_AUDIT_MAX_DURATION_MS: '1.5' }, { DELETION_AUDIT_MAX_DURATION_MS: '300001' },
    ]) assert.throws(() => loadDeletionAuditConfig({ ...ENV, ...change }));
});
