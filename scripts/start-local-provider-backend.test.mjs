import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { localProviderEnvironment, startLocalProviderDevelopment } from './start-local-provider-backend.mjs';

const configuration = JSON.parse(await readFile(new URL('./provider-release-us-br.json', import.meta.url), 'utf8'));

test('local profile retains the approved country/consent controls and exact database identity', () => {
    const environment = localProviderEnvironment(configuration, { NODE_ENV: 'development' });
    assert.equal(environment.DB_HOST, '127.0.0.1');
    assert.equal(environment.DB_NAME, 'cms');
    assert.equal(environment.DB_USER, 'cms_mickeyf');
    assert.equal(environment.LUDOLUME_LOCAL_PROVIDER_RUNTIME, 'true');
    assert.equal(environment.LUDOLUME_LOCAL_PROVIDER_MAINTENANCE_ENABLED, 'true');
    assert.equal(environment.LUDOLUME_LOCAL_PROVIDER_EXPECTED_SERVER_UUID, configuration.environment.APPLE_MAINTENANCE_EXPECTED_SERVER_UUID);
    assert.equal(environment.SSLKEYLOGFILE, '');
    assert.equal(environment.PARENT_SIGNED_FORMS_ENABLED, 'true');
    assert.deepEqual(JSON.parse(environment.PARENT_REGISTRATION_COUNTRIES), ['US']);
    assert.deepEqual(JSON.parse(environment.PUBLIC_SCORE_COUNTRY_RULES).BR.selfAgeBands, ['adult']);
});

test('cloud workloads, isolated tests and injected credential sources cannot enter the local profile', () => {
    for (const inherited of [{ K_SERVICE: 'mickeyf-org' }, { NODE_ENV: 'production' },
        { LUDOLUME_ISOLATED_RUNTIME: 'true' }, { GOOGLE_APPLICATION_CREDENTIALS: 'not-allowed' },
        { APPLE_SIGN_IN_PRIVATE_KEY: 'not-allowed' }, { APPLE_TOKEN_ENCRYPTION_KEYS: 'not-allowed' }]) {
        assert.throws(() => localProviderEnvironment(configuration, inherited));
    }
    const changed = structuredClone(configuration);
    changed.environment.APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION = 'projects/other/secrets/other/versions/1';
    assert.throws(() => localProviderEnvironment(changed, {}));
    assert.throws(() => localProviderEnvironment({ ...configuration, phase: 'prepare' }, {}));
});

test('import and offline planning do not start services or expose inherited private environment values', () => {
    const path = fileURLToPath(new URL('./start-local-provider-backend.mjs', import.meta.url));
    const marker = randomBytes(32).toString('hex');
    const result = spawnSync(process.execPath, [path, '--plan-only'], {
        encoding: 'utf8', env: { ...process.env, SESSION_SECRET: marker, DB_PASS: marker }, timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.planOnly, true);
    assert.equal(plan.rootEnvModified, false);
    assert.equal(plan.privateValuesIncluded, false);
    assert.ok(!result.stdout.includes(marker));
    const noAction = spawnSync(process.execPath, [path], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(noAction.status, 1);
    assert.match(noAction.stderr, /--plan-only.*--run/u);
});

test('a failed fresh compilation prevents service startup; success preserves the reviewed environment', async () => {
    const environment = localProviderEnvironment(configuration, { NODE_ENV: 'development' });
    const calls = [];
    await assert.rejects(startLocalProviderDevelopment(environment, async (args, actualEnvironment) => {
        calls.push(args);
        assert.equal(actualEnvironment, environment);
        return 1;
    }), /compilation failed.*not started/u);
    assert.deepEqual(calls, [['--prefix', 'backend', 'run', 'build:dev']]);
    calls.length = 0;
    const result = await startLocalProviderDevelopment(environment, async (args, actualEnvironment) => {
        calls.push(args);
        assert.equal(actualEnvironment, environment);
        return calls.length === 1 ? 0 : 7;
    });
    assert.deepEqual(calls, [['--prefix', 'backend', 'run', 'build:dev'], ['run', 'backend:dev:local']]);
    assert.equal(result, 7);
});
