const assert = require('node:assert/strict');
const test = require('node:test');
const { runtimeEnvironment, validateContainer } = require('./dev-isolated.cjs');

const credentials = { instanceId: 'local-instance', runtimePassword: 'local-runtime', sessionSecret: 'local-session' };
function containerFixture() {
    const port = [{ HostIp: '127.0.0.1', HostPort: '3307' }];
    return { Name: '/ludolume-dev-mysql', State: { Running: true },
        Config: {
            Image: 'mysql:8.0.31@sha256:3d7ae561cf6095f6aca8eb7830e1d14734227b1fb4748092f2be2cfbccf7d614',
            Labels: { 'com.ludolume.development': 'isolated-backend-v1', 'com.ludolume.instance': credentials.instanceId },
        },
        HostConfig: { AutoRemove: false, Privileged: false, NetworkMode: 'bridge', PortBindings: { '3306/tcp': port } },
        NetworkSettings: { Ports: { '3306/tcp': structuredClone(port) } },
        Mounts: [{ Type: 'volume', Destination: '/var/lib/mysql' }],
    };
}

test('runtime explicitly targets development and removes inherited production credentials/options', () => {
    const env = runtimeEnvironment(credentials, {
        PATH: 'retained-path', NODE_ENV: 'production', BACKEND_PORT: '9999',
        DB_HOST: 'production', DB_PORT: '3306', DB_NAME: 'cms', DB_USER: 'operator', DB_PASS: 'production-password',
        SESSION_SECRET: 'production-session', CLOUD_SQL_CONNECTION_NAME: 'production-sql',
        GOOGLE_APPLICATION_CREDENTIALS: 'production-file', MIGRATION_DB_PASS: 'production-migration',
        ACCOUNT_DELETION_ENABLED: 'true', PROVIDER_AUTH_ENABLED: 'true', NODE_OPTIONS: '--require injected',
    });
    assert.equal(env.PATH, 'retained-path');
    assert.equal(env.NODE_ENV, 'development');
    assert.equal(env.BACKEND_PORT, '8080');
    assert.equal(env.DB_HOST, '127.0.0.1');
    assert.equal(env.DB_PORT, '3307');
    assert.equal(env.DB_NAME, 'ludolume_development');
    assert.equal(env.DB_USER, 'ludolume_dev');
    assert.equal(env.DB_PASS, credentials.runtimePassword);
    assert.equal(env.SESSION_SECRET, credentials.sessionSecret);
    assert.equal(env.ACCOUNT_DELETION_ENABLED, 'false');
    assert.equal(env.P4_VEGA_SCORE_SUBMISSIONS_ENABLED, 'true');
    assert.equal(env.THREE_BOSSES_RUN_SUBMISSIONS_ENABLED, 'true');
    for (const key of ['CLOUD_SQL_CONNECTION_NAME', 'GOOGLE_APPLICATION_CREDENTIALS', 'MIGRATION_DB_PASS',
        'PROVIDER_AUTH_ENABLED', 'NODE_OPTIONS']) assert.equal(env[key], undefined, key);
});

test('container guard accepts only the owned pinned local container, including a stopped retained instance', () => {
    const running = containerFixture();
    assert.equal(validateContainer(running, credentials), running);
    const stopped = containerFixture();
    stopped.State.Running = false;
    stopped.NetworkSettings.Ports = {};
    assert.equal(validateContainer(stopped, credentials), stopped);
});

test('container guard rejects identity, image, published-port and host-access collisions', () => {
    const mutations = [
        container => { container.Name = '/another-mysql'; },
        container => { container.Config.Image = 'mysql:latest'; },
        container => { container.Config.Labels['com.ludolume.instance'] = 'another-instance'; },
        container => { container.Config.Labels['com.ludolume.development'] = 'other'; },
        container => { container.HostConfig.PortBindings['3306/tcp'][0].HostIp = '0.0.0.0'; },
        container => { container.HostConfig.PortBindings['3306/tcp'][0].HostPort = '3306'; },
        container => { container.HostConfig.PortBindings['33060/tcp'] = []; },
        container => { container.NetworkSettings.Ports['3306/tcp'][0].HostIp = '0.0.0.0'; },
        container => { container.HostConfig.NetworkMode = 'host'; },
        container => { container.HostConfig.Privileged = true; },
        container => { container.HostConfig.AutoRemove = true; },
        container => { container.Mounts[0].Type = 'bind'; },
    ];
    for (const mutate of mutations) {
        const container = containerFixture();
        mutate(container);
        assert.throws(() => validateContainer(container, credentials), /refusing to connect/);
    }
});
