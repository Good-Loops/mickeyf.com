import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHandoffTests, runProcess, TEST_COMMAND } from './run-apple-android-handoff-tests.mjs';
import { rehearsalEnvironment } from './run-parent-consent-rehearsal.mjs';

const command = ['--test', '--test-timeout=120000', '-r', 'ts-node/register',
    'ts/accounts/parentFormAppleRelayState.integration.test.ts'];

export function runParentRelayStateRehearsal({ run = runProcess, ...options } = {}) {
    return runHandoffTests({ ...options, run: (executable, args, execution) => {
        if (executable !== TEST_COMMAND.executable) return run(executable, args, execution);
        if (JSON.stringify(args) !== JSON.stringify(TEST_COMMAND.args)) throw new Error('UNEXPECTED_REHEARSAL_COMMAND');
        return run(executable, command, { ...execution, env: rehearsalEnvironment(execution.env) });
    } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length !== 2) {
        console.error('Usage: node backend/scripts/run-parent-relay-state-rehearsal.mjs (SYNTHETIC TEST ONLY)');
        process.exitCode = 1;
    } else {
        const controller = new AbortController();
        const abort = () => controller.abort();
        process.once('SIGINT', abort); process.once('SIGTERM', abort);
        console.log('SYNTHETIC TEST ONLY - Local disposable Apple relay state rehearsal.');
        runParentRelayStateRehearsal({ signal: controller.signal }).catch(error => {
            console.error(error.message); process.exitCode = 1;
        }).finally(() => {
            process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
        });
    }
}
