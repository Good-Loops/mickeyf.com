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
    return runChildSchemaTests({ ...options, run: async (executable, args, execution) => {
        const invocation = imageTestInvocation(executable, args, execution);
        let cleanupFailure;
        if (args.includes('compose') && args.includes('down')) {
            const project = args[args.indexOf('--project-name') + 1];
            try {
                await cleanupImageProbes(run, executable, args.slice(0, args.indexOf('compose')), project, execution);
            } catch { cleanupFailure = new Error('OWNED_IMAGE_PROBE_CLEANUP_FAILED'); }
        }
        const output = await run(executable, invocation.args, invocation.execution);
        if (cleanupFailure) throw cleanupFailure;
        return output;
    } });
}

// Compose does not reliably remove containers it did not create. Verify every
// probe before removing it, then let the existing outer cleanup handle MySQL.
export async function cleanupImageProbes(run, executable, dockerHost, project, execution) {
    if (!/^mickeyf-apple-handoff-[1-9][0-9]*-[a-f0-9]{12}$/u.test(project)) throw new Error('INVALID_TEST_PROJECT');
    const invoke = args => run(executable, [...dockerHost, ...args], execution);
    const output = await invoke(['ps', '--all', '--no-trunc', '--filter', `label=com.mickeyf.schema-project=${project}`, '--format', '{{.ID}}']);
    const ids = output.trim() ? output.trim().split(/\r?\n/u) : [];
    if (ids.length > 4 || ids.some(id => !/^[a-f0-9]{64}$/u.test(id))) throw new Error('INVALID_PROBE_INVENTORY');
    for (const id of ids) {
        const containers = JSON.parse(await invoke(['inspect', '--type', 'container', id]));
        const container = containers.length === 1 ? containers[0] : null;
        if (container?.Id !== id || container.Config?.Image !== RUNTIME_IMAGE
            || container.Config?.Labels?.['com.mickeyf.schema-project'] !== project
            || !/^[0-9a-f-]{36}$/u.test(container.Config?.Labels?.['com.mickeyf.probe'] ?? '')
            || container.HostConfig?.NetworkMode !== 'none') throw new Error('PROBE_OWNERSHIP_MISMATCH');
        await invoke(['rm', '--force', id]);
    }
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
