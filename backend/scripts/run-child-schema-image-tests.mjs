import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChildSchemaTests } from './run-child-schema-tests.mjs';
import { runProcess, TEST_COMMAND } from './run-apple-android-handoff-tests.mjs';

const overlay = fileURLToPath(new URL('../../compose.child-schema-image-test.yaml', import.meta.url));

// The serving image was read back from Cloud Run on 4 November 2026. This
// rehearsal uses cached bytes, no cloud credentials, and a disposable database.
export const RUNTIME_IMAGE = 'us-central1-docker.pkg.dev/noted-reef-387021/cloud-run-source-deploy/cloud-run-source-deploy@sha256:1bb849217045edb86764177a10014d366f230f3e249c881cf91a984574148360';

export function imageTestInvocation(executable, args, execution) {
    if (executable === TEST_COMMAND.executable) {
        return { args, execution: { ...execution, env: { ...execution.env,
            CHILD_SCHEMA_IMAGE_TEST: '1', CHILD_SCHEMA_RUNTIME_IMAGE: RUNTIME_IMAGE } } };
    }
    const compose = args.indexOf('compose');
    if (compose === -1) return { args, execution };
    const file = args.indexOf('--file', compose);
    if (file < 0 || typeof args[file + 1] !== 'string') throw new Error('EXPLICIT_TEST_COMPOSE_REQUIRED');
    return { args: [...args.slice(0, file + 2), '--file', overlay, ...args.slice(file + 2)], execution };
}

export function runChildSchemaImageTests({ run = runProcess, ...options } = {}) {
    return runChildSchemaTests({ ...options, run: (executable, args, execution) => {
        const invocation = imageTestInvocation(executable, args, execution);
        return run(executable, invocation.args, invocation.execution);
    } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length !== 2) {
        console.error('Usage: node backend/scripts/run-child-schema-image-tests.mjs (cached image and disposable local SQL only)');
        process.exitCode = 1;
    } else {
        const controller = new AbortController();
        const abort = () => controller.abort();
        process.once('SIGINT', abort); process.once('SIGTERM', abort);
        runChildSchemaImageTests({ signal: controller.signal }).catch(error => {
            console.error(error.message); process.exitCode = 1;
        }).finally(() => {
            process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
        });
    }
}
