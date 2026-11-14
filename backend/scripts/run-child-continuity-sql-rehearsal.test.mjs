import assert from 'node:assert/strict';
import test from 'node:test';
import { MYSQL_IMAGE } from './run-apple-android-handoff-tests.mjs';
import { runChildContinuityRehearsal } from './run-child-continuity-sql-rehearsal.mjs';

for (const fail of [false, true]) test(`continuity SQL rehearsal isolates credentials and cleans up after ${fail ? 'failure' : 'success'}`, async () => {
    const id = 'c'.repeat(64), calls = [];
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
        assert.deepEqual(args, ['--test', '--test-timeout=120000', '-r', 'ts-node/register',
            'ts/accounts/childContinuitySqlRehearsal.integration.test.ts']);
        assert.equal(options.env.SYNTHETIC_PARENT_CONSENT_REHEARSAL, '1');
        assert.equal(options.env.MIGRATION_DB_HOST, '127.0.0.1'); assert.equal(options.env.MIGRATION_DB_PORT, '49152');
        for (const name of ['DB_HOST', 'DB_PASS', 'GOOGLE_APPLICATION_CREDENTIALS', 'NODE_OPTIONS']) assert.equal(options.env[name], undefined);
        if (fail) throw new Error('SYNTHETIC_FAILURE');
        return 'synthetic continuity SQL passed';
    };
    const execution = runChildContinuityRehearsal({ run, environment: { DB_HOST: 'production', DB_PASS: 'private',
        GOOGLE_APPLICATION_CREDENTIALS: 'private', NODE_OPTIONS: '--require private' }, report() {} });
    if (fail) await assert.rejects(execution, /SYNTHETIC_FAILURE/u); else await execution;
    assert.equal(calls.filter(call => call.executable === process.execPath).length, 1);
    assert(calls.at(-1).args.includes('down')); assert(calls.at(-1).args.includes('--volumes'));
});
