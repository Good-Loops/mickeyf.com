import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { loadRetirementSecrets, loadRetirementTarget } from './runRetirementOperator';

const keys = generateKeyPairSync('ed25519');
const env = { MIGRATION_DB_HOST: '127.0.0.1', MIGRATION_DB_PORT: '13306', MIGRATION_DB_NAME: 'cms',
    MIGRATION_DB_USER: 'ludolume_release_ops', MIGRATION_DB_PASS: 'synthetic-password',
    MIGRATION_CONFIRM_DATABASE: 'cms', MIGRATION_CONFIRM_TARGET: '127.0.0.1:13306/cms',
    MIGRATION_CONFIRM_ACCOUNT: 'ludolume_release_ops@cloudsqlproxy~%',
    MIGRATION_CONFIRM_SERVER_UUID: 'd1e6865c-ecad-11ee-a6b0-42010a400002',
    MIGRATION_CONFIRM_CLOUD_SQL_PROJECT: 'noted-reef-387021', MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE: 'cms-mickeyf',
    MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME: 'noted-reef-387021:us-central1:cms-mickeyf', RETIREMENT_SOURCE_COMMIT: 'a'.repeat(40),
    CHILD_INACTIVITY_KEYS: `${'01'.repeat(32)}:${'02'.repeat(32)}:${'03'.repeat(32)}`,
    CHILD_ACTIVITY_CONTINUITY_KEY: '04'.repeat(32),
    RETIREMENT_PUBLIC_KEY_PEM: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    RETIREMENT_PRIVATE_KEY_PEM: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };

test('pins the actual database, operator, provider and reviewed source', () => {
    assert.equal(loadRetirementTarget(env).pins.database, 'cms');
    for (const patch of [{ MIGRATION_DB_HOST: 'example.com' }, { MIGRATION_CONFIRM_SERVER_UUID: 'different' },
        { MIGRATION_CONFIRM_ACCOUNT: 'cms_mickeyf@cloudsqlproxy~%' }, { RETIREMENT_SOURCE_COMMIT: '' },
        { MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE: 'other' }]) assert.throws(() => loadRetirementTarget({ ...env, ...patch }));
});
test('rejects reused or mismatched private keys', () => {
    const result = loadRetirementSecrets(env);
    assert.equal(result.guardKey.length, 32);
    assert.throws(() => loadRetirementSecrets({ ...env, CHILD_ACTIVITY_CONTINUITY_KEY: '02'.repeat(32) }));
    assert.throws(() => loadRetirementSecrets({ ...env, RETIREMENT_PRIVATE_KEY_PEM:
        generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }));
    assert.throws(() => loadRetirementSecrets({ ...env, CHILD_INACTIVITY_KEYS: 'bad' }));
});
