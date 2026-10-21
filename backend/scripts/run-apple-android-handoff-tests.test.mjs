import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MYSQL_IMAGE, TEST_COMMAND, assertLocalDockerEndpoint, dockerExecutable, isolatedEnvironment,
    runHandoffTests, runProcess, verifyContainer } from './run-apple-android-handoff-tests.mjs';

const id = 'a'.repeat(64);
function container(project) {
    return { Id: id, Config: { Image: MYSQL_IMAGE, Labels: { 'com.docker.compose.project': project,
        'com.docker.compose.service': 'mysql', 'com.mickeyf.purpose': 'migration-test', 'com.mickeyf.scope': 'local-test-only' } },
    State: { Running: true, Health: { Status: 'healthy' } },
    NetworkSettings: { Ports: { '3306/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] } } };
}

function fixture({ inspect = value => value, existing = '', testError, cleanupError, endpoint = 'unix:///var/run/docker.sock' } = {}) {
    const calls = [];
    const run = async (executable, args, options) => {
        calls.push({ executable, args, options });
        if (args[0] === 'context') return JSON.stringify(endpoint);
        if (args.includes('down')) { if (cleanupError) throw cleanupError; return ''; }
        if (args.includes('--all')) return existing;
        if (args.includes('up')) return '';
        if (args.includes('inspect')) {
            const compose = calls.find(call => call.args.includes('--project-name'));
            return JSON.stringify([inspect(container(compose.args[compose.args.indexOf('--project-name') + 1]))]);
        }
        if (args.includes('ps')) return id;
        assert.equal(executable, process.execPath);
        if (testError) throw testError;
        return 'synthetic SQL tests passed';
    };
    return { calls, run };
}

test('the fixed SQL command is cross-platform, focused and deadline bounded', () => {
    assert.equal(dockerExecutable('win32'), 'docker.exe');
    assert.equal(dockerExecutable('linux'), 'docker');
    assert.deepEqual(TEST_COMMAND.args, ['--test', '--test-timeout=120000', '-r', 'ts-node/register',
        'ts/auth/appleAndroidHandoffRepository.integration.test.ts']);
    assert.equal(Object.isFrozen(TEST_COMMAND.args), true);
});

test('child environment drops production credentials, Node preloads and all inherited harness overrides', () => {
    const source = { PATH: 'safe-bin', SystemRoot: 'safe-root', DOCKER_CONTEXT: 'desktop-linux',
        DATABASE_URL: 'private', DB_HOST: 'private', DB_PORT: '3306', DB_NAME: 'private', DB_USER: 'private',
        DB_PASS: 'private', DB_PASSWORD: 'private', CLOUD_SQL_CONNECTION_NAME: 'private',
        GOOGLE_APPLICATION_CREDENTIALS: 'private', SESSION_SECRET: 'private', NODE_OPTIONS: '--require private',
        NODE_PATH: 'private', TS_NODE_PROJECT: 'private', COMPOSE_FILE: 'private', COMPOSE_PROJECT_NAME: 'private',
        COMPOSE_ENV_FILES: 'private', MYSQL_HOST: 'private', MIGRATION_DB_HOST: 'private',
        APPLE_ANDROID_HANDOFF_TEST_PORT: '3306', APPLE_ANDROID_HANDOFF_TEST_ENABLED: '1' };
    assert.deepEqual(isolatedEnvironment(source), { PATH: 'safe-bin', SystemRoot: 'safe-root',
        DOCKER_CONTEXT: 'desktop-linux', COMPOSE_DISABLE_ENV_FILE: '1' });
    assert.equal(source.DB_HOST, 'private');
});

test('only a local Unix socket or local Windows pipe daemon is accepted', () => {
    for (const endpoint of ['unix:///var/run/docker.sock', 'npipe:////./pipe/dockerDesktopLinuxEngine']) {
        assert.doesNotThrow(() => assertLocalDockerEndpoint(endpoint));
    }
    for (const endpoint of [null, '', 'tcp://127.0.0.1:2375', 'ssh://host', 'tcp://production:2376',
        'npipe:////remote/pipe/docker_engine', 'unix:///var/run/docker.sock\n']) {
        assert.throws(() => assertLocalDockerEndpoint(endpoint), /LOCAL_DOCKER_REQUIRED/u);
    }
});

test('identity guards reject wrong image, container, labels, health and all non-loopback/default ports', () => {
    assert.equal(verifyContainer([container('project')], 'project', id), '49152');
    const mutations = [value => { value.Id = 'b'.repeat(64); }, value => { value.Config.Image = 'mysql:latest'; },
        ...['com.docker.compose.project', 'com.docker.compose.service', 'com.mickeyf.purpose', 'com.mickeyf.scope']
            .map(key => value => { value.Config.Labels[key] = 'other'; }),
        value => { value.State.Running = false; }, value => { value.State.Health.Status = 'starting'; },
        value => { value.NetworkSettings.Ports['3306/tcp'][0].HostIp = '0.0.0.0'; },
        ...['3306', 3306, '0', '65536', '03306', '49152\n'].map(port => value => { value.NetworkSettings.Ports['3306/tcp'][0].HostPort = port; }),
        value => { value.NetworkSettings.Ports['3306/tcp'].push({ HostIp: '::', HostPort: '49152' }); }];
    for (const mutate of mutations) {
        const value = container('project'); mutate(value);
        assert.throws(() => verifyContainer([value], 'project', id), /ISOLATED_MYSQL_IDENTITY_REQUIRED/u);
    }
    for (const malformed of [null, [], [container('project'), container('project')]]) {
        assert.throws(() => verifyContainer(malformed, 'project', id), /ISOLATED_MYSQL_IDENTITY_REQUIRED/u);
    }
});

test('orchestration verifies a fresh project before exactly one test and always scoped cleanup', async () => {
    const f = fixture();
    const result = await runHandoffTests({ run: f.run, platform: 'win32', report() {},
        environment: { PATH: 'safe', DOCKER_CONTEXT: 'desktop-linux', DB_HOST: 'production', NODE_OPTIONS: '--require private' } });
    assert.match(result.project, /^mickeyf-apple-handoff-[0-9]+-[a-f0-9]{12}$/u);
    assert.equal(result.port, '49152');
    const testCall = f.calls.find(call => call.executable === process.execPath);
    assert.deepEqual(testCall.args, TEST_COMMAND.args);
    assert.match(testCall.options.cwd.replaceAll('\\', '/'), /\/backend$/u);
    assert.equal(testCall.options.env.DB_HOST, undefined);
    assert.equal(testCall.options.env.NODE_OPTIONS, undefined);
    assert.equal(testCall.options.env.DOCKER_CONTEXT, undefined);
    assert.equal(f.calls[0].options.env.DOCKER_CONTEXT, 'desktop-linux');
    assert.deepEqual(Object.fromEntries(Object.entries(testCall.options.env).filter(([key]) => key.startsWith('APPLE_'))), {
        APPLE_ANDROID_HANDOFF_TEST_ENABLED: '1', APPLE_ANDROID_HANDOFF_TEST_CONTAINER: id,
        APPLE_ANDROID_HANDOFF_TEST_PORT: '49152' });
    assert.equal(testCall.options.env.NODE_ENV, 'test');
    const up = f.calls.find(call => call.args.includes('up'));
    assert.deepEqual(up.args.slice(-8), ['up', '--detach', '--wait', '--wait-timeout', '90', '--pull', 'never', 'mysql']);
    for (const call of f.calls.filter(call => call.executable !== process.execPath)) assert.equal(call.executable, 'docker.exe');
    for (const call of f.calls.slice(1).filter(call => call.executable !== process.execPath)) {
        assert.deepEqual(call.args.slice(0, 2), ['--host', 'unix:///var/run/docker.sock']);
        assert.equal(call.options.env.DOCKER_CONTEXT, undefined);
    }
    const cleanup = f.calls.at(-1);
    assert.deepEqual(cleanup.args.slice(-5), ['down', '--volumes', '--remove-orphans', '--timeout', '30']);
    assert.equal(cleanup.args[cleanup.args.indexOf('--project-name') + 1], result.project);
    assert.equal(cleanup.options.signal, undefined);
    assert.equal(cleanup.options.timeoutMs, 45_000);
});

test('an inherited daemon override or remote daemon cannot start Docker resources', async () => {
    const f = fixture();
    await assert.rejects(runHandoffTests({ run: f.run, environment: { DOCKER_HOST: 'private' } }), /DOCKER_HOST_OVERRIDE_FORBIDDEN/u);
    assert.equal(f.calls.length, 0);
    const remote = fixture({ endpoint: 'ssh://production' });
    await assert.rejects(runHandoffTests({ run: remote.run, environment: {}, report() {} }), /LOCAL_DOCKER_REQUIRED/u);
    assert.equal(remote.calls.length, 1);
});

test('preexisting project is never started, tested or removed', async () => {
    const f = fixture({ existing: id });
    await assert.rejects(runHandoffTests({ run: f.run, environment: {}, report() {} }), /DISPOSABLE_PROJECT_NOT_EMPTY/u);
    assert.equal(f.calls.length, 2);
});

test('failed identity never reaches SQL and still cleans only its own started project', async () => {
    const f = fixture({ inspect: value => { value.Config.Labels['com.mickeyf.scope'] = 'production'; return value; } });
    await assert.rejects(runHandoffTests({ run: f.run, environment: {}, report() {} }), /ISOLATED_MYSQL_IDENTITY_REQUIRED/u);
    assert.equal(f.calls.some(call => call.executable === process.execPath), false);
    assert.equal(f.calls.at(-1).args.includes('down'), true);
});

test('test failure still cleans up, and cleanup failure cannot produce a passing run', async () => {
    for (const options of [{ testError: new Error('SQL_FAILED') }, { cleanupError: new Error('cleanup') }]) {
        const f = fixture(options);
        await assert.rejects(runHandoffTests({ run: f.run, environment: {}, report() {} }),
            options.testError ? /SQL_FAILED/u : /DISPOSABLE_MYSQL_CLEANUP_FAILED/u);
        assert.equal(f.calls.at(-1).args.includes('down'), true);
    }
});

test('actual subprocess capture stops unbounded output and hung children', async () => {
    for (const [script, options, expected] of [
        ['process.stdout.write("x".repeat(2048));setInterval(()=>{},1000)', { maxBytes: 100 }, 'COMMAND_OUTPUT_LIMIT'],
        ['setInterval(()=>{},1000)', { timeoutMs: 100 }, 'COMMAND_DEADLINE'],
    ]) {
        await assert.rejects(runProcess(process.execPath, ['-e', script], { env: isolatedEnvironment(process.env),
            timeoutMs: 10_000, ...options }), error => error.message === expected && error.output.length <= 100);
    }
});

test('both CI runtime jobs invoke the SQL runner immediately after migration tests', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/pr-ci.yml', import.meta.url), 'utf8');
    assert.equal([...workflow.matchAll(/npm --prefix backend run test:migrations\r?\n\s+node backend\/scripts\/run-apple-android-handoff-tests\.mjs/gu)].length, 2);
    assert.match(workflow, /node --test[^\r\n]+backend\/scripts\/run-apple-android-handoff-tests\.test\.mjs/u);
});
