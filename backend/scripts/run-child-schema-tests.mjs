import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment, runHandoffTests, runProcess, TEST_COMMAND } from './run-apple-android-handoff-tests.mjs';

export const CHILD_SCHEMA_TEST_COMMAND = Object.freeze(['--test', '--test-timeout=120000', '-r', 'ts-node/register',
    'ts/migrations/childSignedFormOperation.integration.test.ts']);

export function childSchemaTestEnvironment(verified) {
    const port = verified.APPLE_ANDROID_HANDOFF_TEST_PORT;
    if (verified.NODE_ENV !== 'test' || verified.APPLE_ANDROID_HANDOFF_TEST_ENABLED !== '1'
        || !/^[a-f0-9]{64}$/u.test(verified.APPLE_ANDROID_HANDOFF_TEST_CONTAINER ?? '')
        || !/^[1-9][0-9]{0,4}$/u.test(port ?? '') || Number(port) > 65535 || port === '3306') {
        throw new Error('VERIFIED_DISPOSABLE_CHILD_SCHEMA_TEST_REQUIRED');
    }
    return { ...isolatedEnvironment(verified), NODE_ENV: 'test', CHILD_SCHEMA_TEST_ENABLED: '1',
        CHILD_SCHEMA_TEST_CONTAINER: verified.APPLE_ANDROID_HANDOFF_TEST_CONTAINER,
        MIGRATION_TEST_ENABLED: '1', MIGRATION_TEST_PORT: port,
        MIGRATION_TEST_ROOT_PASSWORD: 'migration-test-root-only', MIGRATION_DB_HOST: '127.0.0.1',
        MIGRATION_DB_PORT: port, MIGRATION_DB_NAME: 'mickeyf_migration_test', MIGRATION_DB_USER: 'migration_test',
        MIGRATION_DB_PASS: 'migration-test-only', MIGRATION_CONFIRM_DATABASE: 'mickeyf_migration_test',
        MIGRATION_CONFIRM_TARGET: `127.0.0.1:${port}/mickeyf_migration_test`, MIGRATION_CONFIRM_ACCOUNT: 'migration_test@%',
        MIGRATION_ALLOW_APPLY: '1' };
}

export function runChildSchemaTests({ run = runProcess, ...options } = {}) {
    return runHandoffTests({ ...options, run: (executable, args, execution) => {
        if (executable !== TEST_COMMAND.executable) return run(executable, args, execution);
        if (JSON.stringify(args) !== JSON.stringify(TEST_COMMAND.args)) throw new Error('UNEXPECTED_CHILD_SCHEMA_TEST_COMMAND');
        return run(executable, CHILD_SCHEMA_TEST_COMMAND, { ...execution, env: childSchemaTestEnvironment(execution.env) });
    } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length !== 2) {
        console.error('Usage: node backend/scripts/run-child-schema-tests.mjs (disposable local database only)');
        process.exitCode = 1;
    } else {
        const controller = new AbortController();
        const abort = () => controller.abort();
        process.once('SIGINT', abort); process.once('SIGTERM', abort);
        runChildSchemaTests({ signal: controller.signal }).catch(error => {
            console.error(error.message); process.exitCode = 1;
        }).finally(() => {
            process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
        });
    }
}
