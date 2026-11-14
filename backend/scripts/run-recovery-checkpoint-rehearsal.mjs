import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHandoffTests, runProcess, TEST_COMMAND } from './run-apple-android-handoff-tests.mjs';
import { rehearsalEnvironment } from './run-parent-consent-rehearsal.mjs';

const command = Object.freeze(['--test', '--test-timeout=120000', '-r', 'ts-node/register',
  'ts/accounts/accountRecoveryCheckpoint.integration.test.ts']);

/** Reuse the pinned, disposable MySQL harness; no production target is accepted. */
export function runRecoveryCheckpointRehearsal({ run = runProcess, ...options } = {}) {
  return runHandoffTests({ ...options, run: (executable, args, execution) => {
    if (executable !== TEST_COMMAND.executable) return run(executable, args, execution);
    if (JSON.stringify(args) !== JSON.stringify(TEST_COMMAND.args)) throw new Error('UNEXPECTED_CHECKPOINT_COMMAND');
    return run(executable, command, { ...execution, env: rehearsalEnvironment(execution.env) });
  } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { console.error('No target arguments are accepted.'); process.exitCode = 1; }
  else runRecoveryCheckpointRehearsal().catch(error => { console.error(error.message); process.exitCode = 1; });
}
