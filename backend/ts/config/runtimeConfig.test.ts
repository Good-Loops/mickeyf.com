import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig, loadRuntimeConfig } from './runtimeConfig';

const productionEnvironment = {
    NODE_ENV: 'production',
    SESSION_SECRET: 'test-only-secret-value-with-32-characters-minimum',
    BACKEND_PORT: '8080',
    DB_USER: 'test-user',
    DB_PASS: 'test-password',
    DB_NAME: 'test-database',
    CLOUD_SQL_CONNECTION_NAME: 'test-project:test-region:test-instance',
};

test('production runtime configuration allows only the website, packaged iOS and exact local preview origins', () => {
    const config = loadRuntimeConfig(productionEnvironment);

    assert.equal(config.isProduction, true);
    assert.equal(config.port, 8080);
    assert.equal(config.p4VegaScoreSubmissionsEnabled, false);
    assert.equal(config.threeBossesRunSubmissionsEnabled, false);
    assert.deepEqual(config.corsOrigins, [
        'https://mickeyf.com',
        'https://www.mickeyf.com',
        'capacitor://localhost',
        'http://localhost:5173',
    ]);
    for (const origin of [
        'null',
        'http://localhost',
        'http://localhost:5174',
        'http://127.0.0.1:5173',
        'http://192.168.0.106:5173',
        'http://localhost:5173.evil.example',
        'https://localhost',
        'capacitor://localhost:5173',
        'capacitor://localhost.evil.example',
        'https://mickeyf.com.evil.example',
    ]) {
        assert.equal(config.corsOrigins.includes(origin), false, origin);
    }
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
