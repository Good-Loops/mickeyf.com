import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { loadRecoveryDatabaseTarget, ORIGINAL_DATABASE_CONNECTION } from './recoveryDatabaseTarget';
import { loadDatabaseConfig } from './runtimeConfig';
import { loadAppleMaintenanceConfig } from './appleMaintenanceConfig';
import { loadDeletionAuditConfig } from './deletionAuditConfig';
import { loadAppleRevocationConfig } from './appleRevocationConfig';
import { loadReceiptCleanupConfig } from './receiptCleanupConfig';
import { verifyRecoveryDatabaseIdentity } from '../db/recoveryDatabaseIdentity';

const target = { formatVersion: 1 as const, connectionName: 'noted-reef-387021:us-central1:cms-recovery-fixture',
    serverUuid: '11111111-2222-4333-8444-555555555555' };
const shared = { NODE_ENV: 'production', LUDOLUME_RESTORED_DATABASE_TARGET: JSON.stringify(target) };
const runtime = { ...shared, DB_USER: 'cms_mickeyf', DB_PASS: 'synthetic-only', DB_NAME: 'cms',
    CLOUD_SQL_CONNECTION_NAME: target.connectionName, APPLE_MAINTENANCE_EXPECTED_SERVER_UUID: target.serverUuid,
    APPLE_MAINTENANCE_HTTP_ENABLED: 'true', APPLE_MAINTENANCE_CALLER_SUBJECT: '123456789012345678901' };
const audit = { ...shared, DELETION_AUDIT_DB_USER: 'deletion_audit', DELETION_AUDIT_DB_PASSWORD: 'synthetic-only',
    DELETION_AUDIT_DB_NAME: 'cms', DELETION_AUDIT_DB_CURRENT_USER: 'deletion_audit@cloudsqlproxy~%',
    DELETION_AUDIT_CLOUD_SQL_CONNECTION_NAME: target.connectionName, DELETION_AUDIT_DB_SERVER_UUID: target.serverUuid,
    DELETION_AUDIT_IDENTITY_EPOCH: '2026-09-12 00:15:39.954172' };
const revocation = { ...shared, APPLE_REVOCATION_RUN_ENABLED: 'true', APPLE_REVOCATION_DB_USER: 'cms_mickeyf',
    APPLE_REVOCATION_DB_PASS: 'synthetic-only', APPLE_REVOCATION_DB_NAME: 'cms', APPLE_REVOCATION_EXPECTED_ACCOUNT: 'cms_mickeyf@%',
    APPLE_REVOCATION_CLOUD_SQL_CONNECTION_NAME: target.connectionName, APPLE_REVOCATION_EXPECTED_SERVER_UUID: target.serverUuid };
const receipts = { ...shared, RECEIPT_CLEANUP_ENABLED: 'true', RECEIPT_CLEANUP_DB_USER: 'receipt_cleanup',
    RECEIPT_CLEANUP_DB_PASS: 'synthetic-only', RECEIPT_CLEANUP_DB_NAME: 'cms', RECEIPT_CLEANUP_EXPECTED_ACCOUNT: 'receipt_cleanup@cloudsqlproxy~%',
    RECEIPT_CLEANUP_CLOUD_SQL_CONNECTION_NAME: target.connectionName, RECEIPT_CLEANUP_EXPECTED_SERVER_UUID: target.serverUuid };

test('one restored target configures runtime, HTTP maintenance, audit and both cleanup jobs consistently', () => {
    assert.deepEqual(loadRecoveryDatabaseTarget(shared), target);
    assert.equal(loadDatabaseConfig(runtime).cloudSqlConnectionName, target.connectionName);
    assert.deepEqual(loadDatabaseConfig(runtime).recoveryTarget, target);
    assert.equal(loadAppleMaintenanceConfig(runtime)?.expectedServerUuid, target.serverUuid);
    for (const config of [loadDeletionAuditConfig(audit), loadAppleRevocationConfig(['apply'], revocation), loadReceiptCleanupConfig(receipts)]) {
        assert.equal(config.databaseOptions.socketPath, `/cloudsql/${target.connectionName}`);
        assert.equal(config.databaseOptions.database, 'cms');
    }
});

test('no target preserves the original fixed audit and revocation paths; recovery does not enable features', () => {
    assert.equal(loadRecoveryDatabaseTarget({ NODE_ENV: 'production' }), undefined);
    assert.equal(loadDeletionAuditConfig({ ...audit, LUDOLUME_RESTORED_DATABASE_TARGET: undefined,
        DELETION_AUDIT_CLOUD_SQL_CONNECTION_NAME: ORIGINAL_DATABASE_CONNECTION }).databaseOptions.socketPath, `/cloudsql/${ORIGINAL_DATABASE_CONNECTION}`);
    assert.equal(loadAppleRevocationConfig(['apply'], { ...revocation, LUDOLUME_RESTORED_DATABASE_TARGET: undefined,
        APPLE_REVOCATION_CLOUD_SQL_CONNECTION_NAME: ORIGINAL_DATABASE_CONNECTION }).databaseOptions.socketPath, `/cloudsql/${ORIGINAL_DATABASE_CONNECTION}`);
    assert.throws(() => loadDeletionAuditConfig({ ...audit, LUDOLUME_RESTORED_DATABASE_TARGET: undefined }));
    assert.throws(() => loadAppleRevocationConfig(['apply'], { ...revocation, LUDOLUME_RESTORED_DATABASE_TARGET: undefined }));
    assert.equal(loadAppleMaintenanceConfig({ ...runtime, APPLE_MAINTENANCE_HTTP_ENABLED: 'false' }), undefined);
    assert.throws(() => loadReceiptCleanupConfig({ ...receipts, RECEIPT_CLEANUP_ENABLED: 'false' }));
    assert.throws(() => loadAppleRevocationConfig(['apply'], { ...revocation, APPLE_REVOCATION_RUN_ENABLED: 'false' }));
});

test('malformed, original, cross-project and nonproduction recovery contracts are rejected', () => {
    for (const value of ['', '{}', 'null', '[]', JSON.stringify({ ...target, extra: true }),
        JSON.stringify({ ...target, formatVersion: 2 }), JSON.stringify({ ...target, connectionName: ORIGINAL_DATABASE_CONNECTION }),
        JSON.stringify({ ...target, serverUuid: 'd1e6865c-ecad-11ee-a6b0-42010a400002' }),
        JSON.stringify({ ...target, serverUuid: 'invalid' }), JSON.stringify({ ...target, connectionName: 'other-project:us-central1:cms-copy' }),
        JSON.stringify({ ...target, connectionName: 'noted-reef-387021:europe-west1:cms-copy' })]) {
        assert.throws(() => loadRecoveryDatabaseTarget({ ...shared, LUDOLUME_RESTORED_DATABASE_TARGET: value }));
    }
    assert.throws(() => loadRecoveryDatabaseTarget({ ...shared, NODE_ENV: 'test' }));
    assert.throws(() => loadDatabaseConfig({ ...runtime, NODE_ENV: 'test' }));
});

test('every enabled consumer rejects mixed original/restored socket and UUID pins', () => {
    for (const bad of [ORIGINAL_DATABASE_CONNECTION, 'noted-reef-387021:us-central1:another-restore']) {
        assert.throws(() => loadDatabaseConfig({ ...runtime, CLOUD_SQL_CONNECTION_NAME: bad }));
        assert.throws(() => loadAppleMaintenanceConfig({ ...runtime, CLOUD_SQL_CONNECTION_NAME: bad }));
        assert.throws(() => loadDeletionAuditConfig({ ...audit, DELETION_AUDIT_CLOUD_SQL_CONNECTION_NAME: bad }));
        assert.throws(() => loadAppleRevocationConfig(['apply'], { ...revocation, APPLE_REVOCATION_CLOUD_SQL_CONNECTION_NAME: bad }));
        assert.throws(() => loadReceiptCleanupConfig({ ...receipts, RECEIPT_CLEANUP_CLOUD_SQL_CONNECTION_NAME: bad }));
    }
    const oldUuid = 'd1e6865c-ecad-11ee-a6b0-42010a400002';
    assert.throws(() => loadDatabaseConfig({ ...runtime, APPLE_MAINTENANCE_EXPECTED_SERVER_UUID: oldUuid }));
    assert.throws(() => loadAppleMaintenanceConfig({ ...runtime, APPLE_MAINTENANCE_EXPECTED_SERVER_UUID: oldUuid }));
    assert.throws(() => loadDeletionAuditConfig({ ...audit, DELETION_AUDIT_DB_SERVER_UUID: oldUuid }));
    assert.throws(() => loadAppleRevocationConfig(['apply'], { ...revocation, APPLE_REVOCATION_EXPECTED_SERVER_UUID: oldUuid }));
    assert.throws(() => loadReceiptCleanupConfig({ ...receipts, RECEIPT_CLEANUP_EXPECTED_SERVER_UUID: oldUuid }));
    for (const changed of [{ DB_USER: 'root' }, { DB_NAME: 'cms-copy' }, { DB_HOST: '127.0.0.1' }, { DB_PORT: '3306' }]) {
        assert.throws(() => loadDatabaseConfig({ ...runtime, ...changed }));
    }
});

test('startup verifies actual restored database, account and UUID before accepting traffic', async () => {
    const identity = { databaseName: 'cms', currentUser: 'cms_mickeyf@%', serverUuid: target.serverUuid };
    const connection = (rows: unknown) => ({ query: async () => [rows] }) as unknown as Pick<PoolConnection, 'query'>;
    await verifyRecoveryDatabaseIdentity(connection([identity]), target);
    for (const rows of [[], [identity, identity], [{ ...identity, databaseName: 'cms-copy' }],
        [{ ...identity, currentUser: 'root@%' }], [{ ...identity, serverUuid: 'd1e6865c-ecad-11ee-a6b0-42010a400002' }]]) {
        await assert.rejects(verifyRecoveryDatabaseIdentity(connection(rows), target));
    }
});
