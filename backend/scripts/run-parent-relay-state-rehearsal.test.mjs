import assert from 'node:assert/strict';
import test from 'node:test';
import { MYSQL_IMAGE } from './run-apple-android-handoff-tests.mjs';
import { runParentRelayStateRehearsal } from './run-parent-relay-state-rehearsal.mjs';

for (const fail of [false, true]) test(`relay rehearsal isolates credentials and cleans its disposable database after ${fail ? 'failure' : 'success'}`, async () => {
    const calls = []; const id = 'a'.repeat(64);
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
        assert.equal(executable, process.execPath);
        assert(args.includes('ts/accounts/parentFormAppleRelayState.integration.test.ts'));
        assert.equal(options.env.MIGRATION_DB_HOST, '127.0.0.1');
        assert.equal(options.env.MIGRATION_DB_NAME, 'mickeyf_migration_test');
        assert.equal(options.env.DB_PASS, undefined);
        assert.equal(options.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
        if (fail) throw new Error('SYNTHETIC_FAILURE');
        return 'SYNTHETIC TEST ONLY';
    };
    const operation = runParentRelayStateRehearsal({ run, environment: {
        DB_PASS: 'production', GOOGLE_APPLICATION_CREDENTIALS: 'private',
    }, report() {} });
    if (fail) await assert.rejects(operation, /SYNTHETIC_FAILURE/u); else await operation;
    assert(calls.at(-1).args.includes('down')); assert(calls.at(-1).args.includes('--volumes'));
});
