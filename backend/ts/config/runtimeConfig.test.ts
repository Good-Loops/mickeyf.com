import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig, loadRuntimeConfig } from './runtimeConfig';
import { DELETION_JOURNAL_BUCKET } from '../accounts/gcsDeletionJournal';

const productionEnvironment = {
    NODE_ENV: 'production',
    SESSION_SECRET: 'test-only-secret-value-with-32-characters-minimum',
    BACKEND_PORT: '8080',
    DB_USER: 'test-user',
    DB_PASS: 'test-password',
    DB_NAME: 'test-database',
    CLOUD_SQL_CONNECTION_NAME: 'test-project:test-region:test-instance',
};

test('production runtime configuration allows only the website and packaged iOS origins', () => {
    const config = loadRuntimeConfig(productionEnvironment);

    assert.equal(config.isProduction, true);
    assert.equal(config.port, 8080);
    assert.equal(config.p4VegaScoreSubmissionsEnabled, false);
    assert.equal(config.threeBossesRunSubmissionsEnabled, false);
    assert.equal(config.accountDeletionEnabled, false);
    assert.deepEqual(config.providerAuth, { enabled: false, signupEnabled: false, clients: {}, publicClients: [] });
    assert.deepEqual(config.corsOrigins, [
        'https://mickeyf.com',
        'https://www.mickeyf.com',
        'capacitor://localhost',
    ]);
    for (const origin of [
        'null',
        'http://localhost',
        'http://localhost:5173',
        'https://localhost',
        'capacitor://localhost:5173',
        'capacitor://localhost.evil.example',
        'https://mickeyf.com.evil.example',
    ]) {
        assert.equal(config.corsOrigins.includes(origin), false, origin);
    }
});

test('provider runtime configuration stays disabled without exact opt-in in every environment', () => {
    for (const nodeEnv of ['development', 'test', 'production']) {
        for (const enabled of [undefined, '', 'false', 'TRUE', '1', ' true ']) {
            const config = loadRuntimeConfig({ ...productionEnvironment, NODE_ENV: nodeEnv,
                PROVIDER_AUTH_ENABLED: enabled, GOOGLE_WEB_CLIENT_ID: 'ignored-while-disabled' });
            assert.equal(config.providerAuth.enabled, false);
            assert.deepEqual(config.providerAuth.publicClients, []);
        }
    }
});

test('enabled provider runtime configuration requires exact server-owned client IDs', () => {
    assert.throws(() => loadRuntimeConfig({ ...productionEnvironment, PROVIDER_AUTH_ENABLED: 'true' }),
        /GOOGLE_WEB_CLIENT_ID or APPLE_IOS_BUNDLE_ID/);
    const clientId = '1234567890-synthetic.apps.googleusercontent.com';
    const config = loadRuntimeConfig({ ...productionEnvironment, PROVIDER_AUTH_ENABLED: 'true', GOOGLE_WEB_CLIENT_ID: clientId });
    assert.equal(config.providerAuth.enabled, true);
    assert.deepEqual(Object.keys(config.providerAuth.clients), ['google-web']);
    assert.deepEqual(config.providerAuth.publicClients, [
        { clientKey: 'google-web', provider: 'google', platform: 'web', clientId },
    ]);
    assert.throws(() => loadRuntimeConfig({ ...productionEnvironment, PROVIDER_AUTH_ENABLED: 'true',
        GOOGLE_WEB_CLIENT_ID: ` ${clientId}` }), /GOOGLE_WEB_CLIENT_ID/);
});

test('account deletion defaults off in every environment and requires exact opt-in', () => {
    for (const nodeEnv of ['development', 'test', 'production']) {
        for (const value of [undefined, '', 'false', 'TRUE', '1', ' true ', 'yes']) {
            const config = loadRuntimeConfig({
                ...productionEnvironment,
                NODE_ENV: nodeEnv,
                ACCOUNT_DELETION_ENABLED: value,
            });
            assert.equal(config.accountDeletionEnabled, false, `${nodeEnv}: ${value}`);
        }
    }
    const enabled = loadRuntimeConfig({
        ...productionEnvironment,
        ACCOUNT_DELETION_ENABLED: 'true',
        ACCOUNT_DELETION_JOURNAL_BUCKET: DELETION_JOURNAL_BUCKET,
        ACCOUNT_IDENTITY_EPOCH: '2026-09-11 23:00:00.123456',
    });
    assert.equal(enabled.accountDeletionEnabled, true);
    assert.equal(enabled.journalBucket, DELETION_JOURNAL_BUCKET);
});

test('production Google signup cannot create passwordless users without available deletion', () => {
    const env = { ...productionEnvironment, PROVIDER_AUTH_ENABLED: 'true',
        PROVIDER_GOOGLE_SIGNUP_ENABLED: 'true', GOOGLE_WEB_CLIENT_ID: 'synthetic.apps.googleusercontent.com' };
    assert.throws(() => loadRuntimeConfig(env), /Google signup requires account deletion/);
    assert.equal(loadRuntimeConfig({ ...env, NODE_ENV: 'development' }).providerAuth.signupEnabled, true);
    assert.equal(loadRuntimeConfig({ ...env, ACCOUNT_DELETION_ENABLED: 'true',
        ACCOUNT_DELETION_JOURNAL_BUCKET: DELETION_JOURNAL_BUCKET,
        ACCOUNT_IDENTITY_EPOCH: '2026-09-11 23:00:00.123456' }).providerAuth.signupEnabled, true);
});

test('enabled deletion requires an independently captured identity epoch', () => {
    for (const epoch of [undefined, '', 'now', '2026-09-11 23:00:00']) {
        assert.throws(() => loadRuntimeConfig({ ...productionEnvironment,
            ACCOUNT_DELETION_JOURNAL_BUCKET: DELETION_JOURNAL_BUCKET,
            ACCOUNT_DELETION_ENABLED: 'true', ACCOUNT_IDENTITY_EPOCH: epoch }), /ACCOUNT_IDENTITY_EPOCH/);
    }
    assert.equal(loadRuntimeConfig(productionEnvironment).accountIdentityEpoch, undefined);
});

test('enabled deletion refuses development or implicit production-journal access', () => {
    const enabledEnvironment = {
        ...productionEnvironment,
        ACCOUNT_DELETION_ENABLED: 'true',
        ACCOUNT_IDENTITY_EPOCH: '2026-09-11 23:00:00.123456',
        ACCOUNT_DELETION_JOURNAL_BUCKET: DELETION_JOURNAL_BUCKET,
    };
    for (const nodeEnv of ['development', 'test']) {
        assert.throws(() => loadRuntimeConfig({ ...enabledEnvironment, NODE_ENV: nodeEnv }), /requires production/);
    }
    for (const bucket of [undefined, '', 'other-bucket', ` ${DELETION_JOURNAL_BUCKET}`]) {
        assert.throws(() => loadRuntimeConfig({ ...enabledEnvironment, ACCOUNT_DELETION_JOURNAL_BUCKET: bucket }),
            /ACCOUNT_DELETION_JOURNAL_BUCKET/);
    }
    assert.equal(loadRuntimeConfig(productionEnvironment).journalBucket, undefined);
});

test('Three Bosses run submissions require the exact positive runtime opt-in', () => {
    const enabled = loadRuntimeConfig({
        ...productionEnvironment,
        THREE_BOSSES_RUN_SUBMISSIONS_ENABLED: 'true',
    });
    assert.equal(enabled.threeBossesRunSubmissionsEnabled, true);

    for (const value of ['', 'false', 'TRUE', '1', ' true ', 'yes']) {
        const disabled = loadRuntimeConfig({
            ...productionEnvironment,
            THREE_BOSSES_RUN_SUBMISSIONS_ENABLED: value,
        });
        assert.equal(disabled.threeBossesRunSubmissionsEnabled, false);
    }
});

test('p4-Vega score submissions require the exact positive runtime opt-in', () => {
    const enabled = loadRuntimeConfig({
        ...productionEnvironment,
        P4_VEGA_SCORE_SUBMISSIONS_ENABLED: 'true',
    });
    assert.equal(enabled.p4VegaScoreSubmissionsEnabled, true);

    for (const value of ['', 'false', 'TRUE', '1', ' true ', 'yes']) {
        const frozen = loadRuntimeConfig({
            ...productionEnvironment,
            P4_VEGA_SCORE_SUBMISSIONS_ENABLED: value,
        });
        assert.equal(frozen.p4VegaScoreSubmissionsEnabled, false);
    }
});

test('runtime configuration rejects missing, weak, and malformed values', () => {
    assert.throws(
        () => loadRuntimeConfig({ ...productionEnvironment, SESSION_SECRET: 'too-short' }),
        /SESSION_SECRET/
    );
    assert.throws(
        () => loadRuntimeConfig({ ...productionEnvironment, BACKEND_PORT: '70000' }),
        /BACKEND_PORT/
    );
    assert.throws(
        () => loadRuntimeConfig({ ...productionEnvironment, NODE_ENV: 'prod' }),
        /NODE_ENV/
    );
});

test('database configuration fails closed and uses bounded local connection inputs', () => {
    const productionDatabase = loadDatabaseConfig(productionEnvironment);
    assert.equal(productionDatabase.cloudSqlConnectionName, productionEnvironment.CLOUD_SQL_CONNECTION_NAME);
    assert.equal(productionDatabase.host, undefined);

    assert.throws(
        () => loadDatabaseConfig({ ...productionEnvironment, CLOUD_SQL_CONNECTION_NAME: '' }),
        /CLOUD_SQL_CONNECTION_NAME/
    );

    const developmentDatabase = loadDatabaseConfig({
        NODE_ENV: 'development',
        DB_USER: 'test-user',
        DB_PASS: 'test-password',
        DB_NAME: 'test-database',
    });
    assert.equal(developmentDatabase.host, 'localhost');
    assert.equal(developmentDatabase.port, 3306);
});
