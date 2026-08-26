import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { loadMigrationManifest } from '../migrations/migrationManifest';
import { applyMigrations } from '../migrations/migrationRunner';
import {
    applyP4GrantRetirement,
    applyRuntimeGrants,
    assertRuntimeSessionsDrained,
    planP4GrantRetirement,
    planRuntimeGrants,
    type RuntimeGrantConnection,
    type RuntimeGrantSettings,
    type RuntimeRoleRemover,
    verifyP4GrantRetirement,
    verifyRuntimeGrants,
} from './runtimeGrantOperations';
import type { RuntimeDatabaseAccount } from './runtimeGrantManifest';

const migrationTestPort = Number(process.env.MIGRATION_TEST_PORT);
const DATABASE = 'mickeyf_migration_test';
const RUNTIME_ACCOUNT: RuntimeDatabaseAccount = Object.freeze({
    user: 'runtime_operation_test',
    host: '%',
});
const RUNTIME_PASSWORD = 'runtime-operation-test-only';
const BROAD_ROLE: RuntimeDatabaseAccount = Object.freeze({
    user: 'mock_cloudsqlsuperuser',
    host: '%',
});
const RUNTIME_PRINCIPAL = "'runtime_operation_test'@'%'";
const BROAD_ROLE_PRINCIPAL = "'mock_cloudsqlsuperuser'@'%'";
const PROCESS_OBSERVER_PRINCIPAL = "'runtime_process_observer_test'@'%'";
const PROCESS_ROLE_PRINCIPAL = "'runtime_process_role_test'@'%'";
const PROCESS_OBSERVER_PASSWORD = 'runtime-process-observer-test-only';

const config = loadMigrationConfig();
const migrations = loadMigrationManifest();
let administrator: Connection;
let root: Connection;
let settings: RuntimeGrantSettings;

function asMigrationConnection(value: Connection): MigrationConnection {
    return value as unknown as MigrationConnection;
}

function asRuntimeGrantConnection(value: Connection): RuntimeGrantConnection {
    return value as unknown as RuntimeGrantConnection;
}

function assertSafeTestEnvironment(): void {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.MIGRATION_TEST_ENABLED, '1');
    assert.equal(process.env.CLOUD_SQL_CONNECTION_NAME, undefined);
    assert.ok(Number.isSafeInteger(migrationTestPort));
    assert.ok(migrationTestPort >= 1 && migrationTestPort <= 65_535);
    assert.notEqual(migrationTestPort, 3306);
    assert.deepEqual({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
    }, {
        host: '127.0.0.1',
        port: migrationTestPort,
        database: DATABASE,
        user: 'migration_test',
    });
}

async function createSchema(): Promise<void> {
    await administrator.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        await administrator.query(`
            DROP TABLE IF EXISTS
                game_personal_bests,
                game_runs,
                schema_migrations,
                users
        `);
    } finally {
        await administrator.query('SET FOREIGN_KEY_CHECKS = 1');
    }
    await administrator.query(`
        CREATE TABLE users (
            user_id INT NOT NULL AUTO_INCREMENT,
            user_name VARCHAR(255) NOT NULL,
            email VARCHAR(255) NOT NULL,
            user_password VARCHAR(255) NOT NULL,
            p4_score INT NULL,
            CONSTRAINT pk_users PRIMARY KEY (user_id),
            UNIQUE KEY uq_users_email (email)
        ) ENGINE = InnoDB
          DEFAULT CHARACTER SET = utf8mb4
          COLLATE = utf8mb4_unicode_ci
    `);
    await applyMigrations(asMigrationConnection(administrator), migrations, config);
}

async function dropFixtureAccounts(): Promise<void> {
    await root.query('SET GLOBAL mandatory_roles = ?', ['']);
    await root.query(`DROP USER IF EXISTS ${RUNTIME_PRINCIPAL}`);
    await root.query(`DROP ROLE IF EXISTS ${BROAD_ROLE_PRINCIPAL}`);
}

async function dropProcessVisibilityFixtures(): Promise<void> {
    await root.query(`DROP USER IF EXISTS ${PROCESS_OBSERVER_PRINCIPAL}`);
    await root.query(`DROP ROLE IF EXISTS ${PROCESS_ROLE_PRINCIPAL}`);
}

async function installBroadFixture(): Promise<void> {
    await dropFixtureAccounts();
    await root.query(`CREATE ROLE ${BROAD_ROLE_PRINCIPAL}`);
    await root.query(
        'GRANT ALL PRIVILEGES ON `mickeyf_migration_test`.* TO '
        + BROAD_ROLE_PRINCIPAL
    );
    await root.query(
        `CREATE USER ${RUNTIME_PRINCIPAL} IDENTIFIED BY ?`,
        [RUNTIME_PASSWORD]
    );
    await root.query(`GRANT ${BROAD_ROLE_PRINCIPAL} TO ${RUNTIME_PRINCIPAL}`);
    await root.query(`SET DEFAULT ROLE ${BROAD_ROLE_PRINCIPAL} TO ${RUNTIME_PRINCIPAL}`);
}

async function createRuntimeConnection(): Promise<Connection> {
    return mysql.createConnection({
        host: config.host,
        port: config.port,
        user: RUNTIME_ACCOUNT.user,
        password: RUNTIME_PASSWORD,
        database: DATABASE,
        dateStrings: true,
        multipleStatements: false,
    });
}

async function assertRoleMembership(expectedCount: number): Promise<void> {
    const [rows] = await root.query<Array<RowDataPacket & { roleCount: number }>>(`
        SELECT COUNT(*) AS roleCount
        FROM mysql.role_edges
        WHERE FROM_USER = ? AND FROM_HOST = ?
          AND TO_USER = ? AND TO_HOST = ?
    `, [BROAD_ROLE.user, BROAD_ROLE.host, RUNTIME_ACCOUNT.user, RUNTIME_ACCOUNT.host]);
    assert.equal(Number(rows[0].roleCount), expectedCount);
}

async function assertDefaultRoleCount(expectedCount: number): Promise<void> {
    const [rows] = await root.query<Array<RowDataPacket & { roleCount: number }>>(`
        SELECT COUNT(*) AS roleCount
        FROM mysql.default_roles
        WHERE USER = ? AND HOST = ?
    `, [RUNTIME_ACCOUNT.user, RUNTIME_ACCOUNT.host]);
    assert.equal(Number(rows[0].roleCount), expectedCount);
}

function createSqlRoleRemover(onCall?: () => void): RuntimeRoleRemover {
    return async (context) => {
        onCall?.();
        assert.equal(context.provider, settings.roleRemovalProvider);
        assert.equal(context.target, settings.roleRemovalTarget);
        assert.deepEqual(context.runtimeAccount, RUNTIME_ACCOUNT);
        assert.deepEqual(context.approvedRole, BROAD_ROLE);
        await root.query(`REVOKE ${BROAD_ROLE_PRINCIPAL} FROM ${RUNTIME_PRINCIPAL}`);
    };
}

before(async () => {
    assertSafeTestEnvironment();
    administrator = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        dateStrings: true,
        multipleStatements: false,
    });
    root = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: process.env.MIGRATION_TEST_ROOT_USER,
        password: process.env.MIGRATION_TEST_ROOT_PASSWORD,
        database: config.database,
        dateStrings: true,
        multipleStatements: false,
    });
    const [versionRows] = await root.query<Array<RowDataPacket & {
        version: string;
        serverUuid: string;
        currentUser: string;
    }>>(
        'SELECT @@version AS version, @@GLOBAL.server_uuid AS serverUuid, '
        + 'CURRENT_USER() AS currentUser'
    );
    assert.match(versionRows[0].version, /^8\.0\.31(?:-|$)/u);
    const currentUserSeparator = versionRows[0].currentUser.lastIndexOf('@');
    assert.ok(currentUserSeparator > 0);
    settings = Object.freeze({
        database: DATABASE,
        expectedServerUuid: versionRows[0].serverUuid.toLowerCase(),
        maintenanceAccount: Object.freeze({
            user: versionRows[0].currentUser.slice(0, currentUserSeparator),
            host: versionRows[0].currentUser.slice(currentUserSeparator + 1),
        }),
        approvedRole: BROAD_ROLE,
        roleRemovalProvider: 'local-mysql-test',
        roleRemovalTarget: 'disposable-mysql-8.0.31',
        advisoryLockTimeoutSeconds: 2,
        lockWaitTimeoutSeconds: 5,
    });
    await createSchema();
});

after(async () => {
    if (root) {
        await dropProcessVisibilityFixtures();
        await dropFixtureAccounts();
        await root.end();
    }
    if (administrator) await administrator.end();
});

test('active runtime sessions block role removal, then a drained rerun converges', async () => {
    await installBroadFixture();
    const rootRuntimeConnection = asRuntimeGrantConnection(root);
    const openRuntimeConnection = await createRuntimeConnection();
    let roleRemovalCalls = 0;
    try {
        const [activeRoleRows] = await openRuntimeConnection.query<Array<
            RowDataPacket & { currentRole: string }
        >>('SELECT CURRENT_ROLE() AS currentRole');
        assert.match(activeRoleRows[0].currentRole, /mock_cloudsqlsuperuser/u);

        const initialPlan = await planRuntimeGrants(
            rootRuntimeConnection,
            settings,
            RUNTIME_ACCOUNT
        );
        assert.equal(initialPlan.state, 'broad');
        assert.deepEqual(initialPlan.blockers, []);
        assert.equal(initialPlan.operations.ensureRequiredPrivileges.length, 3);
        assert.equal(
            initialPlan.operations.removeApprovedRole?.approvedRole,
            'mock_cloudsqlsuperuser@%'
        );
        await assert.rejects(
            () => applyRuntimeGrants(
                rootRuntimeConnection,
                settings,
                RUNTIME_ACCOUNT,
                initialPlan.sha256,
                initialPlan.server.uuid,
                createSqlRoleRemover(() => { roleRemovalCalls += 1; })
            ),
            /sessions are still open/
        );
        assert.equal(roleRemovalCalls, 0);
        await assertRoleMembership(1);
        await assertDefaultRoleCount(1);

        const preparedPlan = await planRuntimeGrants(
            rootRuntimeConnection,
            settings,
            RUNTIME_ACCOUNT
        );
        assert.equal(preparedPlan.state, 'broad');
        assert.equal(preparedPlan.operations.ensureRequiredPrivileges.length, 3);
    } finally {
        await openRuntimeConnection.end();
    }

    const recoveryPlan = await planRuntimeGrants(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT
    );
    const finalPlan = await applyRuntimeGrants(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT,
        recoveryPlan.sha256,
        recoveryPlan.server.uuid,
        createSqlRoleRemover(() => { roleRemovalCalls += 1; })
    );
    assert.equal(roleRemovalCalls, 1);
    assert.equal(finalPlan.state, 'reduced');
    assert.equal(finalPlan.compliant, true);
    await assertRoleMembership(0);
    await assertDefaultRoleCount(0);

    const [sharedRoleRows] = await root.query<Array<RowDataPacket & { roleCount: number }>>(
        'SELECT COUNT(*) AS roleCount FROM mysql.user WHERE User = ? AND Host = ?',
        [BROAD_ROLE.user, BROAD_ROLE.host]
    );
    assert.equal(Number(sharedRoleRows[0].roleCount), 1, 'shared role must not be dropped');

    const freshRuntimeConnection = await createRuntimeConnection();
    try {
        await freshRuntimeConnection.query('SET ROLE ALL');
        const [freshRoleRows] = await freshRuntimeConnection.query<Array<
            RowDataPacket & { currentRole: string }
        >>('SELECT CURRENT_ROLE() AS currentRole');
        assert.equal(freshRoleRows[0].currentRole, 'NONE');
        await freshRuntimeConnection.query('SELECT user_id FROM users LIMIT 1');
        await assert.rejects(
            () => freshRuntimeConnection.query('DELETE FROM users WHERE 1 = 0'),
            (error: unknown) => (error as { code?: string }).code === 'ER_TABLEACCESS_DENIED_ERROR'
        );
        const reducedWhileActive = await planRuntimeGrants(
            rootRuntimeConnection,
            settings,
            RUNTIME_ACCOUNT
        );
        await assert.rejects(
            () => applyRuntimeGrants(
                rootRuntimeConnection,
                settings,
                RUNTIME_ACCOUNT,
                reducedWhileActive.sha256,
                reducedWhileActive.server.uuid
            ),
            /sessions are still open/
        );
    } finally {
        await freshRuntimeConnection.end();
    }

    const verified = await verifyRuntimeGrants(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT
    );
    const secondApply = await applyRuntimeGrants(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT,
        verified.sha256,
        verified.server.uuid
    );
    assert.equal(secondApply.sha256, verified.sha256);
});

test('exact p4_score grants retire atomically after runtime sessions drain', async () => {
    await installBroadFixture();
    const rootRuntimeConnection = asRuntimeGrantConnection(root);
    const broadPlan = await planRuntimeGrants(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT
    );
    await applyRuntimeGrants(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT,
        broadPlan.sha256,
        broadPlan.server.uuid,
        createSqlRoleRemover()
    );
    await root.query(
        'GRANT SELECT (`p4_score`), UPDATE (`p4_score`) '
        + 'ON `mickeyf_migration_test`.`users` TO ' + RUNTIME_PRINCIPAL
    );

    const activeRuntimeConnection = await createRuntimeConnection();
    try {
        await activeRuntimeConnection.query('SELECT p4_score FROM users LIMIT 1');
        const readyPlan = await planP4GrantRetirement(
            rootRuntimeConnection,
            settings,
            RUNTIME_ACCOUNT
        );
        assert.equal(readyPlan.state, 'ready');
        assert.deepEqual(readyPlan.blockers, []);
        assert.equal(
            readyPlan.operation,
            'REVOKE SELECT (`p4_score`), UPDATE (`p4_score`) '
            + "ON `mickeyf_migration_test`.`users` FROM 'runtime_operation_test'@'%'"
        );
        await assert.rejects(
            () => applyP4GrantRetirement(
                rootRuntimeConnection,
                settings,
                RUNTIME_ACCOUNT,
                readyPlan.sha256,
                readyPlan.server.uuid
            ),
            /sessions are still open/
        );
    } finally {
        await activeRuntimeConnection.end();
    }

    const refreshedPlan = await planP4GrantRetirement(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT
    );
    const retiredPlan = await applyP4GrantRetirement(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT,
        refreshedPlan.sha256,
        refreshedPlan.server.uuid
    );
    assert.equal(retiredPlan.state, 'retired');
    assert.equal(retiredPlan.compliant, true);

    const freshRuntimeConnection = await createRuntimeConnection();
    try {
        await freshRuntimeConnection.query('SELECT user_id FROM users LIMIT 1');
        await assert.rejects(
            () => freshRuntimeConnection.query('SELECT p4_score FROM users LIMIT 1'),
            (error: unknown) => (error as { code?: string }).code
                === 'ER_COLUMNACCESS_DENIED_ERROR'
        );
    } finally {
        await freshRuntimeConnection.end();
    }

    const verified = await verifyP4GrantRetirement(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT
    );
    const secondApply = await applyP4GrantRetirement(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT,
        verified.sha256,
        verified.server.uuid
    );
    assert.equal(secondApply.sha256, verified.sha256);
    assert.equal(
        (await verifyRuntimeGrants(
            rootRuntimeConnection,
            settings,
            RUNTIME_ACCOUNT
        )).compliant,
        true
    );
});

test('role-remover failure leaves a prepared state that a new approved plan repairs', async () => {
    await installBroadFixture();
    const rootRuntimeConnection = asRuntimeGrantConnection(root);
    const initialPlan = await planRuntimeGrants(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT
    );
    await assert.rejects(
        () => applyRuntimeGrants(
            rootRuntimeConnection,
            settings,
            RUNTIME_ACCOUNT,
            initialPlan.sha256,
            initialPlan.server.uuid,
            async () => { throw new Error('synthetic provider failure'); }
        ),
        /synthetic provider failure/
    );
    await assertRoleMembership(1);
    await assertDefaultRoleCount(0);

    const retryPlan = await planRuntimeGrants(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT
    );
    assert.equal(retryPlan.state, 'prepared');
    const finalPlan = await applyRuntimeGrants(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT,
        retryPlan.sha256,
        retryPlan.server.uuid,
        createSqlRoleRemover()
    );
    assert.equal(finalPlan.compliant, true);
});

test('a provider error after role removal remains explicitly indeterminate', async () => {
    await installBroadFixture();
    const rootRuntimeConnection = asRuntimeGrantConnection(root);
    const initialPlan = await planRuntimeGrants(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT
    );

    await assert.rejects(
        () => applyRuntimeGrants(
            rootRuntimeConnection,
            settings,
            RUNTIME_ACCOUNT,
            initialPlan.sha256,
            initialPlan.server.uuid,
            async () => {
                await root.query(
                    `REVOKE ${BROAD_ROLE_PRINCIPAL} FROM ${RUNTIME_PRINCIPAL}`
                );
                throw new Error('synthetic indeterminate provider outcome');
            }
        ),
        /metadata is compliant.*indeterminate outcome/u
    );
    await assertRoleMembership(0);
    const verified = await verifyRuntimeGrants(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT
    );
    assert.equal(verified.compliant, true);
});

test('session drain proof requires effective PROCESS on a restricted account', async () => {
    await installBroadFixture();
    await dropProcessVisibilityFixtures();
    await root.query(`CREATE ROLE ${PROCESS_ROLE_PRINCIPAL}`);
    await root.query(`GRANT PROCESS ON *.* TO ${PROCESS_ROLE_PRINCIPAL}`);
    await root.query(
        `CREATE USER ${PROCESS_OBSERVER_PRINCIPAL} IDENTIFIED BY ?`,
        [PROCESS_OBSERVER_PASSWORD]
    );
    await root.query(
        `GRANT ${PROCESS_ROLE_PRINCIPAL} TO ${PROCESS_OBSERVER_PRINCIPAL}`
    );

    const observer = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: 'runtime_process_observer_test',
        password: PROCESS_OBSERVER_PASSWORD,
        multipleStatements: false,
    });
    const runtimeConnection = await createRuntimeConnection();
    let runtimeConnectionClosed = false;
    try {
        const [roleRows] = await observer.query<Array<
            RowDataPacket & { currentRole: string }
        >>('SELECT CURRENT_ROLE() AS currentRole');
        assert.equal(roleRows[0].currentRole, 'NONE');
        await assert.rejects(
            () => assertRuntimeSessionsDrained(
                asRuntimeGrantConnection(observer),
                RUNTIME_ACCOUNT
            ),
            /cannot prove effective PROCESS privilege/
        );

        await observer.query(`SET ROLE ${PROCESS_ROLE_PRINCIPAL}`);
        await assert.rejects(
            () => assertRuntimeSessionsDrained(
                asRuntimeGrantConnection(observer),
                RUNTIME_ACCOUNT
            ),
            /sessions are still open/
        );
        await runtimeConnection.end();
        runtimeConnectionClosed = true;
        await assertRuntimeSessionsDrained(
            asRuntimeGrantConnection(observer),
            RUNTIME_ACCOUNT
        );
    } finally {
        if (!runtimeConnectionClosed) {
            await runtimeConnection.end().catch(() => undefined);
        }
        await observer.end();
        await dropProcessVisibilityFixtures();
    }
});

test('stale plans and unsupported privilege state refuse before mutation', async () => {
    const rootRuntimeConnection = asRuntimeGrantConnection(root);
    await installBroadFixture();
    const broadPlan = await planRuntimeGrants(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT
    );
    await applyRuntimeGrants(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT,
        broadPlan.sha256,
        broadPlan.server.uuid,
        createSqlRoleRemover()
    );
    const cleanPlan = await planRuntimeGrants(
        rootRuntimeConnection,
        settings,
        RUNTIME_ACCOUNT
    );
    assert.equal(cleanPlan.compliant, true);
    await root.query(
        'GRANT DELETE ON `mickeyf_migration_test`.`users` TO ' + RUNTIME_PRINCIPAL
    );
    try {
        await assert.rejects(
            () => applyRuntimeGrants(
                rootRuntimeConnection,
                settings,
                RUNTIME_ACCOUNT,
                cleanPlan.sha256,
                cleanPlan.server.uuid
            ),
            /state changed/
        );
        const blockedPlan = await planRuntimeGrants(
            rootRuntimeConnection,
            settings,
            RUNTIME_ACCOUNT
        );
        assert.equal(blockedPlan.state, 'blocked');
        assert.match(blockedPlan.blockers.join(' '), /table privileges/u);
        assert.deepEqual(blockedPlan.operations, {
            ensureRequiredPrivileges: [],
            clearDefaultRoles: [],
            removeApprovedRole: null,
        });
        await assert.rejects(
            () => applyRuntimeGrants(
                rootRuntimeConnection,
                settings,
                RUNTIME_ACCOUNT,
                blockedPlan.sha256,
                blockedPlan.server.uuid
            ),
            /apply is blocked/
        );
    } finally {
        await root.query(
            'REVOKE DELETE ON `mickeyf_migration_test`.`users` FROM '
            + RUNTIME_PRINCIPAL
        );
    }

    await root.query("CREATE ROLE IF NOT EXISTS 'mandatory_runtime_test'@'%'");
    await root.query(
        'SET GLOBAL mandatory_roles = ?',
        ["'mandatory_runtime_test'@'%'"]
    );
    try {
        const blockedPlan = await planRuntimeGrants(
            rootRuntimeConnection,
            settings,
            RUNTIME_ACCOUNT
        );
        assert.equal(blockedPlan.state, 'blocked');
        assert.match(blockedPlan.blockers.join(' '), /mandatory_roles/u);
    } finally {
        await root.query('SET GLOBAL mandatory_roles = ?', ['']);
        await root.query("DROP ROLE IF EXISTS 'mandatory_runtime_test'@'%'");
    }
});
