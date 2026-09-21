const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const { runtimeEnvironment, validateContainer, parseArguments, localProviderGrantStatements } = require('./dev-isolated.cjs');

const credentials = { instanceId: 'local-instance', runtimePassword: 'local-runtime', sessionSecret: 'local-session' };
const googleWebClientId = 'isolated-test.apps.googleusercontent.com';
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
        GOOGLE_WEB_CLIENT_ID: 'inherited.apps.googleusercontent.com', GOOGLE_IOS_CLIENT_ID: 'inherited-ios',
        APPLE_IOS_BUNDLE_ID: 'inherited.apple', APPLE_WEB_CLIENT_ID: 'inherited-apple-web',
        APPLE_WEB_SERVICES_ID: 'inherited-services', APPLE_PRIVATE_KEY: 'inherited-key',
        APPLE_NOTIFICATIONS_ENABLED: 'true', APPLE_TOKEN_LIFECYCLE_ENABLED: 'true',
        LUDOLUME_ISOLATED_RUNTIME: 'false',
        ACCOUNT_DELETION_ENABLED: 'true', PROVIDER_AUTH_ENABLED: 'true', NODE_OPTIONS: '--require injected',
    });
    assert.equal(env.PATH, 'retained-path');
    assert.equal(env.NODE_ENV, 'development');
    assert.equal(env.LUDOLUME_ISOLATED_RUNTIME, 'true');
    assert.equal(env.BACKEND_PORT, '8080');
    assert.equal(env.DB_HOST, '127.0.0.1');
    assert.equal(env.DB_PORT, '3307');
    assert.equal(env.DB_NAME, 'ludolume_development');
    assert.equal(env.DB_USER, 'ludolume_dev');
    assert.equal(env.DB_PASS, credentials.runtimePassword);
    assert.equal(env.SESSION_SECRET, credentials.sessionSecret);
    assert.equal(env.ACCOUNT_DELETION_ENABLED, 'false');
    assert.equal(env.PROVIDER_AUTH_ENABLED, 'false');
    assert.equal(env.P4_VEGA_SCORE_SUBMISSIONS_ENABLED, 'true');
    assert.equal(env.THREE_BOSSES_RUN_SUBMISSIONS_ENABLED, 'true');
    for (const key of ['CLOUD_SQL_CONNECTION_NAME', 'GOOGLE_APPLICATION_CREDENTIALS', 'MIGRATION_DB_PASS',
        'GOOGLE_WEB_CLIENT_ID', 'GOOGLE_IOS_CLIENT_ID', 'APPLE_IOS_BUNDLE_ID', 'APPLE_WEB_CLIENT_ID',
        'APPLE_WEB_SERVICES_ID', 'APPLE_PRIVATE_KEY', 'APPLE_NOTIFICATIONS_ENABLED',
        'APPLE_TOKEN_LIFECYCLE_ENABLED', 'NODE_OPTIONS']) assert.equal(env[key], undefined, key);
});

test('provider CLI opt-in requires one exact bounded Google web client ID', () => {
    assert.deepEqual(parseArguments([]), {});
    const options = parseArguments(['--google-web-client-id', googleWebClientId]);
    assert.deepEqual(options, { googleWebClientId });
    assert.ok(Object.isFrozen(options));
    for (const args of [
        ['--google-web-client-id'], ['--google-web'], [googleWebClientId],
        ['--google-web-client-id=' + googleWebClientId],
        ['--google-web-client-id', googleWebClientId, '--google-web-client-id', googleWebClientId],
        ['--google-web-client-id', googleWebClientId, '--database', 'production'],
    ]) assert.throws(() => parseArguments(args), /Usage:/);
    for (const id of ['', ' ' + googleWebClientId, googleWebClientId + ' ', googleWebClientId + '\n',
        'https://' + googleWebClientId, 'example.com', 'native.apple', 'a'.repeat(256) + '.apps.googleusercontent.com',
        googleWebClientId + ';echo injected']) {
        assert.throws(() => parseArguments(['--google-web-client-id', id]), /exact.*identifier/);
    }
});

test('Google signup is a separate local-only opt-in, never inherited from production', () => {
    const options = parseArguments(['--google-web-client-id', googleWebClientId, '--google-signup']);
    assert.deepEqual(options, { googleWebClientId, googleSignup: true });
    assert.equal(runtimeEnvironment(credentials, {}, options).PROVIDER_GOOGLE_SIGNUP_ENABLED, 'true');
    for (const local of [{}, { googleWebClientId }]) {
        assert.equal(runtimeEnvironment(credentials, { PROVIDER_GOOGLE_SIGNUP_ENABLED: 'true' }, local)
            .PROVIDER_GOOGLE_SIGNUP_ENABLED, 'false');
    }
    assert.equal(runtimeEnvironment(credentials, {}, options).ACCOUNT_DELETION_ENABLED, 'false');
    assert.throws(() => parseArguments(['--google-signup']), /Usage/);
});

test('app bootstrap skips dotenv only for explicit isolated development, never ordinary development or production', () => {
    const appPath = path.join(__dirname, '../ts/app.ts');
    const appSource = readFileSync(appPath, 'utf8');
    const firstImport = appSource.indexOf('\nimport ');
    assert.ok(firstImport > 0, 'bootstrap must precede all app imports');
    const bootstrap = appSource.slice(0, firstImport);
    for (const [env, expectedCalls] of [
        [runtimeEnvironment(credentials, {}), 0],
        [runtimeEnvironment(credentials, {}, parseArguments(['--google-web-client-id', googleWebClientId])), 0],
        [{ NODE_ENV: 'development' }, 1],
        [{ NODE_ENV: 'development', LUDOLUME_ISOLATED_RUNTIME: 'false' }, 1],
        [{ NODE_ENV: 'development', LUDOLUME_ISOLATED_RUNTIME: 'TRUE' }, 1],
        [{ NODE_ENV: 'production' }, 1],
        [{ NODE_ENV: 'production', LUDOLUME_ISOLATED_RUNTIME: 'true' }, 1],
        [{ NODE_ENV: 'test', LUDOLUME_ISOLATED_RUNTIME: 'true' }, 1],
        [{ LUDOLUME_ISOLATED_RUNTIME: 'true' }, 1],
    ]) {
        let calls = 0;
        runInNewContext(bootstrap, {
            process: { env }, __dirname: path.dirname(appPath),
            require(moduleName) {
                if (moduleName === 'path') return path;
                assert.equal(moduleName, 'dotenv', 'bootstrap must not import app or database modules');
                return { config(options) {
                    calls += 1;
                    assert.equal(options.path, path.resolve(__dirname, '../../.env'));
                } };
            },
        });
        assert.equal(calls, expectedCalls, JSON.stringify({ NODE_ENV: env.NODE_ENV,
            LUDOLUME_ISOLATED_RUNTIME: env.LUDOLUME_ISOLATED_RUNTIME }));
    }
});

test('explicit Google opt-in never inherits another provider, credentials or database target', () => {
    const options = parseArguments(['--google-web-client-id', googleWebClientId]);
    const env = runtimeEnvironment(credentials, {
        PROVIDER_AUTH_ENABLED: 'false', GOOGLE_WEB_CLIENT_ID: 'inherited.apps.googleusercontent.com',
        GOOGLE_IOS_CLIENT_ID: 'inherited-ios', APPLE_IOS_BUNDLE_ID: 'inherited.apple',
        APPLE_WEB_CLIENT_ID: 'inherited-apple-web', APPLE_WEB_SERVICES_ID: 'inherited-services',
        APPLE_PRIVATE_KEY: 'inherited-key', GOOGLE_APPLICATION_CREDENTIALS: 'production-file',
        DB_HOST: 'production', DB_PORT: '3306', NODE_ENV: 'production',
    }, options);
    assert.equal(env.PROVIDER_AUTH_ENABLED, 'true');
    assert.equal(env.GOOGLE_WEB_CLIENT_ID, googleWebClientId);
    assert.equal(env.LUDOLUME_ISOLATED_RUNTIME, 'true');
    assert.equal(env.NODE_ENV, 'development');
    assert.equal(env.DB_HOST, '127.0.0.1');
    assert.equal(env.DB_PORT, '3307');
    assert.equal(env.DB_NAME, 'ludolume_development');
    for (const key of ['GOOGLE_IOS_CLIENT_ID', 'APPLE_IOS_BUNDLE_ID', 'APPLE_WEB_CLIENT_ID',
        'APPLE_WEB_SERVICES_ID', 'APPLE_PRIVATE_KEY', 'GOOGLE_APPLICATION_CREDENTIALS']) {
        assert.equal(env[key], undefined, key);
    }
});

test('local provider grants are opt-in and column-scoped to the fixed isolated account and tables', () => {
    assert.deepEqual(localProviderGrantStatements(), []);
    assert.deepEqual(localProviderGrantStatements(parseArguments([])), []);
    const grants = localProviderGrantStatements(parseArguments(['--google-web-client-id', googleWebClientId]));
    assert.ok(Object.isFrozen(grants));
    assert.deepEqual(grants.map(sql => sql.replace(/\s+/g, ' ')), [
        'GRANT SELECT (`provider`, `subject`, `account_uuid`), INSERT (`provider`, `subject`, `account_uuid`, `linked_at`), UPDATE (`linked_at`) ON `ludolume_development`.`account_provider_identities` TO \'ludolume_dev\'@\'%\';',
        'GRANT SELECT (`state_hash`, `binding_hash`, `nonce`, `client_key`, `action`, `user_id`, `account_uuid`, `expires_at`), INSERT (`state_hash`, `binding_hash`, `nonce`, `client_key`, `action`, `user_id`, `account_uuid`, `expires_at`), DELETE ON `ludolume_development`.`provider_auth_attempts` TO \'ludolume_dev\'@\'%\';',
    ]);
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
