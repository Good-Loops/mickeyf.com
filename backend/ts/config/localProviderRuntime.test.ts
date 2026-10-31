import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLocalProviderSecretVersions, loadLocalProviderRuntime, LOCAL_PROVIDER_SERVER_UUID,
    LOCAL_PROVIDER_SECRET_VERSIONS } from './localProviderRuntime';

export const localProviderEnvironment = {
    NODE_ENV: 'development', LUDOLUME_LOCAL_PROVIDER_RUNTIME: 'true',
    LUDOLUME_LOCAL_PROVIDER_EXPECTED_SERVER_UUID: LOCAL_PROVIDER_SERVER_UUID,
    DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_USER: 'cms_mickeyf', DB_NAME: 'cms',
};

test('local provider capability requires its separate explicit development profile', () => {
    assert.equal(loadLocalProviderRuntime({}), undefined);
    assert.equal(loadLocalProviderRuntime({ NODE_ENV: 'production', LUDOLUME_LOCAL_PROVIDER_RUNTIME: 'false' }), undefined);
    assert.deepEqual(loadLocalProviderRuntime(localProviderEnvironment), {
        expectedServerUuid: LOCAL_PROVIDER_SERVER_UUID, expectedAccount: 'cms_mickeyf@%', maintenanceEnabled: false,
    });
    assert.equal(loadLocalProviderRuntime({ ...localProviderEnvironment, DB_HOST: 'localhost' })?.expectedServerUuid,
        LOCAL_PROVIDER_SERVER_UUID);
});

test('local provider profile rejects mixed cloud, isolated, credential-file and database settings', () => {
    for (const override of [
        { LUDOLUME_LOCAL_PROVIDER_RUNTIME: 'TRUE' }, { NODE_ENV: 'production' }, { NODE_ENV: 'test' },
        { K_SERVICE: 'mickeyf-org' }, { K_SERVICE: '' }, { LUDOLUME_ISOLATED_RUNTIME: 'true' },
        { DB_HOST: '192.168.1.2' }, { DB_HOST: undefined }, { DB_PORT: '3307' }, { DB_PORT: undefined },
        { DB_USER: 'root' }, { DB_NAME: 'test' }, { LUDOLUME_LOCAL_PROVIDER_EXPECTED_SERVER_UUID: undefined },
        { LUDOLUME_LOCAL_PROVIDER_EXPECTED_SERVER_UUID: '12345678-1234-1234-1234-123456789abc' },
        { GOOGLE_APPLICATION_CREDENTIALS: 'private-credential-file' },
        { APPLE_SIGN_IN_PRIVATE_KEY: 'private-inline-key' }, { APPLE_TOKEN_ENCRYPTION_KEYS: 'private-inline-key' },
        { LUDOLUME_LOCAL_PROVIDER_MAINTENANCE_ENABLED: '1' },
    ]) assert.throws(() => loadLocalProviderRuntime({ ...localProviderEnvironment, ...override }),
        { message: 'Local provider development requires its explicit loopback database and credential profile.' });
});

test('local Apple runtime credentials require the explicit maintenance runner and same database identity', () => {
    const env = { ...localProviderEnvironment, APPLE_TOKEN_RUNTIME_SECRETS_ENABLED: 'true',
        LUDOLUME_LOCAL_PROVIDER_MAINTENANCE_ENABLED: 'true', APPLE_MAINTENANCE_HTTP_ENABLED: 'true',
        APPLE_MAINTENANCE_EXPECTED_SERVER_UUID: LOCAL_PROVIDER_SERVER_UUID };
    assert.equal(loadLocalProviderRuntime(env)?.maintenanceEnabled, true);
    for (const override of [{ LUDOLUME_LOCAL_PROVIDER_MAINTENANCE_ENABLED: undefined },
        { APPLE_MAINTENANCE_HTTP_ENABLED: 'false' }, { APPLE_MAINTENANCE_EXPECTED_SERVER_UUID: undefined }]) {
        assert.throws(() => loadLocalProviderRuntime({ ...env, ...override }), /verified local maintenance/);
    }
});

test('local credential selection accepts only the two exact approved Apple versions', () => {
    assertLocalProviderSecretVersions(LOCAL_PROVIDER_SECRET_VERSIONS.signing, LOCAL_PROVIDER_SECRET_VERSIONS.encryption);
    assertLocalProviderSecretVersions(LOCAL_PROVIDER_SECRET_VERSIONS.signing.replace('1012884798546', 'noted-reef-387021'),
        LOCAL_PROVIDER_SECRET_VERSIONS.encryption);
    for (const [signing, encryption] of [
        [LOCAL_PROVIDER_SECRET_VERSIONS.signing.replace('/versions/1', '/versions/latest'), LOCAL_PROVIDER_SECRET_VERSIONS.encryption],
        [LOCAL_PROVIDER_SECRET_VERSIONS.signing, LOCAL_PROVIDER_SECRET_VERSIONS.encryption.replace('/versions/1', '/versions/2')],
        [LOCAL_PROVIDER_SECRET_VERSIONS.signing, LOCAL_PROVIDER_SECRET_VERSIONS.signing],
    ]) assert.throws(() => assertLocalProviderSecretVersions(signing, encryption), /reviewed Apple credential versions/);
});
