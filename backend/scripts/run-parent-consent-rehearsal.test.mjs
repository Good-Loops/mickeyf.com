import assert from 'node:assert/strict';
import test from 'node:test';
import { MYSQL_IMAGE } from './run-apple-android-handoff-tests.mjs';
import { REHEARSAL_COMMAND, rehearsalEnvironment, runParentConsentRehearsal } from './run-parent-consent-rehearsal.mjs';

const id = 'a'.repeat(64);
const verified = { NODE_ENV: 'test', APPLE_ANDROID_HANDOFF_TEST_ENABLED: '1', APPLE_ANDROID_HANDOFF_TEST_CONTAINER: id,
    APPLE_ANDROID_HANDOFF_TEST_PORT: '49152' };

test('rehearsal replaces all inherited credentials and targets with fixed synthetic local inputs', () => {
    const env = rehearsalEnvironment({ ...verified, PATH: 'safe', DB_HOST: 'production', DB_PASS: 'private',
        GOOGLE_APPLICATION_CREDENTIALS: 'private', MIGRATION_DB_HOST: 'production', MIGRATION_DB_PASS: 'private',
        SIGNED_FORM_CONFIRM_SERVER_UUID: 'production', NODE_OPTIONS: '--require private' });
    assert.equal(env.PATH, 'safe'); assert.equal(env.MIGRATION_DB_HOST, '127.0.0.1');
    assert.equal(env.MIGRATION_DB_PORT, '49152'); assert.equal(env.MIGRATION_DB_NAME, 'mickeyf_migration_test');
    assert.equal(env.SYNTHETIC_PARENT_CONSENT_REHEARSAL, '1');
    for (const key of ['DB_HOST', 'DB_PASS', 'GOOGLE_APPLICATION_CREDENTIALS', 'SIGNED_FORM_CONFIRM_SERVER_UUID', 'NODE_OPTIONS']) assert.equal(env[key], undefined);
    for (const patch of [{ NODE_ENV: 'production' }, { APPLE_ANDROID_HANDOFF_TEST_ENABLED: '0' },
        { APPLE_ANDROID_HANDOFF_TEST_CONTAINER: 'unknown' }, ...['3306', '0', '65536', '049152', '49152\n']
            .map(port => ({ APPLE_ANDROID_HANDOFF_TEST_PORT: port }))]) {
        assert.throws(() => rehearsalEnvironment({ ...verified, ...patch }), /VERIFIED_DISPOSABLE_REHEARSAL_REQUIRED/u);
    }
});

for (const fail of [false, true]) test(`focused rehearsal retains verified local-container guards and cleanup after ${fail ? 'failure' : 'success'}`, async () => {
    const calls = [];
    const run = async (executable, args, options) => {
        calls.push({ executable, args, options });
        if (args[0] === 'context') return JSON.stringify('unix:///var/run/docker.sock');
        if (args.includes('down') || args.includes('up') || args.includes('--all')) return '';
        if (args.includes('inspect')) {
            const compose = calls.find(call => call.args.includes('--project-name'));
            const project = compose.args[compose.args.indexOf('--project-name') + 1];
            return JSON.stringify([{ Id: id, Config: { Image: MYSQL_IMAGE, Labels: {
                'com.docker.compose.project': project, 'com.docker.compose.service': 'mysql',
                'com.mickeyf.purpose': 'migration-test', 'com.mickeyf.scope': 'local-test-only' } },
            State: { Running: true, Health: { Status: 'healthy' } },
            NetworkSettings: { Ports: { '3306/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] } } }]);
        }
        if (args.includes('ps')) return id;
        assert.equal(executable, process.execPath); assert.deepEqual(args, REHEARSAL_COMMAND);
        assert.equal(options.env.SYNTHETIC_PARENT_CONSENT_REHEARSAL, '1'); assert.equal(options.env.DB_HOST, undefined);
        if (fail) throw new Error('SYNTHETIC_FAILURE');
        return 'SYNTHETIC TEST ONLY';
    };
    const execution = runParentConsentRehearsal({ run, environment: { DB_HOST: 'production' }, report() {} });
    if (fail) await assert.rejects(execution, /SYNTHETIC_FAILURE/u); else await execution;
    assert.equal(calls.filter(call => call.executable === process.execPath).length, 1);
    assert(calls.at(-1).args.includes('down')); assert(calls.at(-1).args.includes('--volumes'));
});
