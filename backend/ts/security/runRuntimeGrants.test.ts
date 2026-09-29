import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import mysql, { type Connection } from 'mysql2/promise';
import * as cloudSql from './cloudSqlRuntimeRoleRemover';
import * as operations from './runtimeGrantOperations';
import { PRODUCTION_RUNTIME_DATABASE_ACCOUNT, PRODUCTION_RUNTIME_DATABASE_ROLE } from './runtimeGrantManifest';
import { runRuntimeGrants } from './runRuntimeGrants';

const approvedDigest = 'a'.repeat(64);
const confirmedEnvironment = {
    MIGRATION_DB_HOST: '127.0.0.1', MIGRATION_DB_PORT: '3306', MIGRATION_DB_USER: 'maintenance-test',
    MIGRATION_DB_PASS: 'synthetic-test-password', MIGRATION_DB_NAME: 'migration_test',
    MIGRATION_CONFIRM_ACCOUNT: 'maintenance-test@%', MIGRATION_CONFIRM_DATABASE: 'migration_test',
    MIGRATION_CONFIRM_TARGET: '127.0.0.1:3306/migration_test', MIGRATION_CONFIRM_RUNTIME_ACCOUNT: 'cms_mickeyf@%',
    MIGRATION_CONFIRM_RUNTIME_ROLE: 'cloudsqlsuperuser@%',
    MIGRATION_CONFIRM_CLOUD_SQL_PROJECT: cloudSql.PRODUCTION_CLOUD_SQL_TARGET.project,
    MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE: cloudSql.PRODUCTION_CLOUD_SQL_TARGET.instance,
    MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME: cloudSql.PRODUCTION_CLOUD_SQL_TARGET.connectionName,
    MIGRATION_CONFIRM_SERVER_UUID: cloudSql.PRODUCTION_CLOUD_SQL_TARGET.serverUuid,
    MIGRATION_CONFIRM_RUNTIME_ROLE_REPLACEMENT: 'cloudsqlsuperuser@% -> no database roles',
    MIGRATION_CONFIRM_RUNTIME_TRAFFIC_DRAINED: '1', MIGRATION_ALLOW_RUNTIME_GRANTS: '1',
    MIGRATION_CONFIRM_RUNTIME_GRANT_PLAN_SHA256: approvedDigest,
};

function fixture(t: TestContext) {
    const previousEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('MIGRATION_')));
    for (const key of Object.keys(previousEnvironment)) delete process.env[key];
    Object.assign(process.env, confirmedEnvironment);
    t.after(() => {
        for (const key of Object.keys(process.env)) if (key.startsWith('MIGRATION_')) delete process.env[key];
        Object.assign(process.env, previousEnvironment);
    });

    const events: string[] = [];
    const identity = { databaseName: 'migration_test', currentUser: 'maintenance-test@%' };
    const query = t.mock.fn(async (sql: string) => {
        assert.equal(sql, 'SELECT DATABASE() AS databaseName, CURRENT_USER() AS currentUser');
        events.push('identity');
        return [[identity], []];
    });
    const end = t.mock.fn(async () => {});
    const destroy = t.mock.fn();
    const destroySocket = t.mock.fn();
    const connection = { query, end, destroy,
        connection: { stream: { destroy: destroySocket } } } as unknown as Connection;
    const connect = t.mock.method(mysql, 'createConnection', async () => {
        events.push('connect');
        return connection;
    });
    const verifyTarget = t.mock.method(cloudSql, 'verifyProductionCloudSqlTarget', async () => { events.push('cloud-target'); });
    const verifyIdle = t.mock.method(cloudSql, 'verifyNoCloudSqlOperationsInFlight', async () => { events.push('cloud-idle'); });
    const roleRemover = t.mock.fn(async () => {});
    const createRoleRemover = t.mock.method(cloudSql, 'createProductionCloudSqlRoleRemover', () => roleRemover);
    const plan = {} as operations.RuntimeGrantPlan;
    const planOperation = t.mock.method(operations, 'planRuntimeGrants', async () => { events.push('plan'); return plan; });
    const verifyOperation = t.mock.method(operations, 'verifyRuntimeGrants', async () => { events.push('verify'); return plan; });
    const applyOperation = t.mock.method(operations, 'applyRuntimeGrants', async () => { events.push('apply'); return plan; });
    const output = t.mock.method(console, 'log', () => {});
    return { identity, query, connection, connect, end, destroy, destroySocket, events, verifyTarget, verifyIdle, createRoleRemover,
        roleRemover, planOperation, verifyOperation, applyOperation, output };
}

test('plan, verify and apply pass the explicit profile or compatible default to the grant operations', async t => {
    for (const command of ['plan', 'verify', 'apply'] as const) {
        for (const profile of [undefined, 'google', 'google-apple'] as const) {
            await t.test(`${command}: ${profile ?? 'default'}`, async t => {
                const f = fixture(t);
                await runRuntimeGrants(profile === undefined ? [command] : [command, `--profile=${profile}`]);
                const operation = command === 'plan' ? f.planOperation : command === 'verify' ? f.verifyOperation : f.applyOperation;
                assert.equal(operation.mock.callCount(), 1);
                const [connection, settings, account] = operation.mock.calls[0].arguments;
                assert.equal(connection, f.connection);
                assert.deepEqual(settings, {
                    profile: profile ?? 'google-apple', database: 'migration_test',
                    expectedServerUuid: cloudSql.PRODUCTION_CLOUD_SQL_TARGET.serverUuid,
                    maintenanceAccount: { user: 'maintenance-test', host: '%' },
                    approvedRole: PRODUCTION_RUNTIME_DATABASE_ROLE,
                    roleRemovalProvider: cloudSql.CLOUD_SQL_ROLE_REMOVAL_PROVIDER,
                    roleRemovalTarget: cloudSql.PRODUCTION_CLOUD_SQL_TARGET.connectionName,
                    advisoryLockTimeoutSeconds: 5, lockWaitTimeoutSeconds: 10,
                });
                assert.deepEqual(account, PRODUCTION_RUNTIME_DATABASE_ACCOUNT);
                assert.equal(f.planOperation.mock.callCount() + f.verifyOperation.mock.callCount() + f.applyOperation.mock.callCount(), 1);
                assert.deepEqual(f.events, command === 'apply'
                    ? ['cloud-target', 'cloud-idle', 'connect', 'identity', 'apply'] : ['connect', 'identity', command]);
                assert.equal(f.end.mock.callCount(), 1);
                assert.equal(f.roleRemover.mock.callCount(), 0);
                if (command === 'apply') {
                    assert.deepEqual(f.applyOperation.mock.calls[0].arguments.slice(3),
                        [approvedDigest, cloudSql.PRODUCTION_CLOUD_SQL_TARGET.serverUuid, f.roleRemover]);
                    assert.equal(f.createRoleRemover.mock.calls[0].arguments[3]?.aborted, false);
                } else {
                    assert.equal(f.createRoleRemover.mock.callCount(), 0);
                }
                assert.doesNotMatch(f.output.mock.calls[0].arguments[0], /synthetic-test-password/u);
            });
        }
    }
});

test('unknown, duplicate, malformed or misplaced profile arguments fail before DB or cloud access', async t => {
    const f = fixture(t);
    for (const args of [
        [], ['unknown'], ['plan', 'google'], ['plan', '--profile', 'google'],
        ['--profile=google', 'plan'], ['plan', '--profile=google', '--profile=google'],
        ['apply', '--profile='], ['apply', '--profile=GOOGLE'], ['apply', '--profile=apple'],
        ['apply', '--profile=google '], ['apply', '--other=google'], ['apply', '--profile=google=apple'],
    ]) {
        await assert.rejects(runRuntimeGrants(args));
    }
    assert.deepEqual(f.events, []);
    assert.equal(f.createRoleRemover.mock.callCount(), 0);
});

test('read-only commands retain exact account, database, target and runtime-account confirmations', async t => {
    const f = fixture(t);
    for (const command of ['plan', 'verify'] as const) {
        for (const key of ['MIGRATION_CONFIRM_ACCOUNT', 'MIGRATION_CONFIRM_DATABASE',
            'MIGRATION_CONFIRM_TARGET', 'MIGRATION_CONFIRM_RUNTIME_ACCOUNT'] as const) {
            delete process.env[key];
            await assert.rejects(runRuntimeGrants([command, '--profile=google']), new RegExp(key));
            process.env[key] = confirmedEnvironment[key];
        }
    }
    assert.deepEqual(f.events, []);
});

test('Google apply retains every mutation confirmation before cloud or DB access', async t => {
    const f = fixture(t);
    for (const key of [
        'MIGRATION_CONFIRM_ACCOUNT', 'MIGRATION_CONFIRM_DATABASE', 'MIGRATION_CONFIRM_TARGET',
        'MIGRATION_CONFIRM_RUNTIME_ACCOUNT', 'MIGRATION_CONFIRM_RUNTIME_ROLE',
        'MIGRATION_CONFIRM_CLOUD_SQL_PROJECT', 'MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE',
        'MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME', 'MIGRATION_CONFIRM_RUNTIME_ROLE_REPLACEMENT',
        'MIGRATION_CONFIRM_RUNTIME_TRAFFIC_DRAINED', 'MIGRATION_ALLOW_RUNTIME_GRANTS',
        'MIGRATION_CONFIRM_RUNTIME_GRANT_PLAN_SHA256', 'MIGRATION_CONFIRM_SERVER_UUID',
    ] as const) {
        delete process.env[key];
        await assert.rejects(runRuntimeGrants(['apply', '--profile=google']), new RegExp(key));
        process.env[key] = confirmedEnvironment[key];
    }
    assert.deepEqual(f.events, []);
    assert.equal(f.createRoleRemover.mock.callCount(), 0);
});

test('Google profile rejects the wrong connected database or maintenance account before a grant operation', async t => {
    const f = fixture(t);
    for (const key of ['databaseName', 'currentUser'] as const) {
        const original = f.identity[key];
        f.identity[key] = 'wrong-target';
        await assert.rejects(runRuntimeGrants(['plan', '--profile=google']), /Connected database or account does not match/u);
        f.identity[key] = original;
    }
    assert.equal(f.query.mock.callCount(), 2);
    assert.equal(f.planOperation.mock.callCount(), 0);
    assert.equal(f.end.mock.callCount(), 2);
});

test('failed cloud verification or in-flight operations prevent the database connection', async t => {
    for (const check of ['verifyProductionCloudSqlTarget', 'verifyNoCloudSqlOperationsInFlight'] as const) {
        await t.test(check, async t => {
            const f = fixture(t);
            t.mock.method(cloudSql, check, async () => { throw new Error('Target unavailable for mutation'); });
            await assert.rejects(runRuntimeGrants(['apply', '--profile=google']), /Target unavailable for mutation/u);
            assert.equal(f.connect.mock.callCount(), 0);
            assert.equal(f.applyOperation.mock.callCount(), 0);
            assert.equal(f.createRoleRemover.mock.callCount(), 0);
        });
    }
});

test('the deadline covers target identity and prevents a late response from starting grant work', async t => {
    const f = fixture(t);
    process.env.MIGRATION_OPERATION_TIMEOUT_MS = '1000';
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let completeIdentity!: (value: [typeof f.identity[], never[]]) => void;
    f.query.mock.mockImplementation(() => new Promise(resolve => { completeIdentity = resolve; }));
    const rejected = assert.rejects(runRuntimeGrants(['plan']), /exceeded 1000ms/u);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.query.mock.callCount(), 1);
    t.mock.timers.tick(1000);
    assert.equal(f.destroy.mock.callCount(), 1);
    assert.equal(f.destroySocket.mock.callCount(), 1);
    await rejected;
    completeIdentity([[f.identity], []]);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.planOperation.mock.callCount(), 0);
    assert.equal(f.output.mock.callCount(), 0);
});

test('apply timeout closes the socket despite driver teardown failure and retains an indeterminate outcome', async t => {
    const f = fixture(t);
    process.env.MIGRATION_OPERATION_TIMEOUT_MS = '1000';
    t.mock.timers.enable({ apis: ['setTimeout'] });
    f.applyOperation.mock.mockImplementation(() => new Promise<never>(() => {}));
    f.destroy.mock.mockImplementation(() => { throw new Error('private teardown failure'); });
    const rejected = assert.rejects(runRuntimeGrants(['apply']), error => {
        assert.ok(error instanceof operations.RuntimeGrantIndeterminateError);
        assert.match(error.message, /may have completed/u);
        assert.doesNotMatch(error.message, /private/u);
        return true;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.applyOperation.mock.callCount(), 1);
    t.mock.timers.tick(2000);
    await rejected;
    assert.equal(f.destroySocket.mock.callCount(), 1);
    assert.equal(f.createRoleRemover.mock.calls[0].arguments[3]?.aborted, true);
    assert.equal(f.output.mock.callCount(), 0);
});

test('stalled or rejected connection shutdown forces socket closure without hanging', async t => {
    for (const mode of ['stalled', 'rejected']) {
        await t.test(mode, async t => {
            const f = fixture(t);
            t.mock.timers.enable({ apis: ['setTimeout'] });
            f.end.mock.mockImplementation(() => mode === 'stalled'
                ? new Promise(() => {}) : Promise.reject(new Error('private shutdown failure')));
            let completed = false;
            const running = runRuntimeGrants(['plan']).then(() => { completed = true; });
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(f.end.mock.callCount(), 1);
            if (mode === 'stalled') {
                assert.equal(completed, false);
                t.mock.timers.tick(1999);
                assert.equal(f.destroySocket.mock.callCount(), 0);
                t.mock.timers.tick(1);
            }
            assert.equal(f.destroySocket.mock.callCount(), 1);
            await running;
            assert.equal(completed, true);
        });
    }
});
