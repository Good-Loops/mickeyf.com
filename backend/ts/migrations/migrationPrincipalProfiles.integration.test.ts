import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, beforeEach, test } from 'node:test';
import mysql, {
    type Connection,
    type RowDataPacket,
} from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import type { MigrationConnection } from './leaderboardSchema';
import { loadMigrationManifest } from './migrationManifest';
import {
    ActiveMigrationPrincipalConnectionsError,
    createTemporaryMigrationPrincipal,
    type MigrationPrincipalAdminConnection,
    revokeTemporaryMigrationPrincipal,
    UnexpectedMigrationTriggerError,
} from './migrationPrincipalManager';
import {
    getMigrationPrincipalProfile,
    MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT,
    MIGRATION_PRINCIPAL_HOST,
    MIGRATION_PRINCIPAL_PROFILE_NAMES,
    MIGRATION_PRINCIPAL_WATCHDOG_ARMER_ACCOUNT,
    type MigrationPrincipalProfileName,
} from './migrationPrincipalProfiles';
import {
    armMigrationPrincipalWatchdog,
    disarmMigrationPrincipalWatchdog,
    getMigrationPrincipalWatchdogEventName,
    MIGRATION_PRINCIPAL_BOOTSTRAP_ROLE,
} from './migrationPrincipalWatchdog';
import {
    backfillP4VegaScores,
    reconcileP4VegaScores,
    type P4VegaBackfillConnection,
} from './p4VegaBackfill';
import {
    applyMigrations,
    planMigrations,
    rollbackEmptyLeaderboardSchema,
} from './migrationRunner';

const migrationTestPort = Number(process.env.MIGRATION_TEST_PORT);
const TEST_DATABASE = 'mickeyf_migration_test';
const SENTINEL_DATABASE = 'mickeyf_privilege_sentinel';
const TEST_PASSWORD = 'migration-profile-test-0123456789abcdef';
const WATCHDOG_DEFINER = 'root@%';
const BOOTSTRAP_PASSWORD = 'migration-bootstrap-test-0123456789abcdef';
const ARMER_PASSWORD = 'migration-armer-test-0123456789abcdef';
const config = loadMigrationConfig();
const migrations = loadMigrationManifest();
let adminConnection: Connection;

function asMigrationConnection(connection: Connection): MigrationConnection {
    return connection as unknown as MigrationConnection;
}

function asBackfillConnection(connection: Connection): P4VegaBackfillConnection {
    return connection as unknown as P4VegaBackfillConnection;
}

function assertSafeTestEnvironment(): void {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.MIGRATION_TEST_ENABLED, '1');
    assert.equal(process.env.CLOUD_SQL_CONNECTION_NAME, undefined);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, migrationTestPort);
    assert.equal(config.database, TEST_DATABASE);
    assert.equal(process.env.MIGRATION_TEST_ROOT_USER, 'root');
    assert.ok(process.env.MIGRATION_TEST_ROOT_PASSWORD);
    assert.ok(Number.isSafeInteger(migrationTestPort));
    assert.ok(migrationTestPort >= 1 && migrationTestPort <= 65_535);
    assert.notEqual(migrationTestPort, 3306);
}

async function dropProfileAccounts(): Promise<void> {
    for (const profileName of MIGRATION_PRINCIPAL_PROFILE_NAMES) {
        const { accountName } = getMigrationPrincipalProfile(profileName);
        await adminConnection.query(
            'DROP USER IF EXISTS ?@?',
            [accountName, MIGRATION_PRINCIPAL_HOST]
        );
    }
}

async function dropBootstrapFixture(): Promise<void> {
    await adminConnection.query(
        'DROP USER IF EXISTS ?@?',
        [MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT, MIGRATION_PRINCIPAL_HOST]
    );
    await adminConnection.query(
        'DROP ROLE IF EXISTS ?@?',
        [MIGRATION_PRINCIPAL_BOOTSTRAP_ROLE, MIGRATION_PRINCIPAL_HOST]
    );
}

async function dropArmerFixture(): Promise<void> {
    await adminConnection.query(
        'DROP USER IF EXISTS ?@?',
        [MIGRATION_PRINCIPAL_WATCHDOG_ARMER_ACCOUNT, MIGRATION_PRINCIPAL_HOST]
    );
}

async function dropWatchdogEvents(): Promise<void> {
    for (const profileName of MIGRATION_PRINCIPAL_PROFILE_NAMES) {
        const eventName = getMigrationPrincipalWatchdogEventName(profileName);
        await adminConnection.query(`DROP EVENT IF EXISTS \`${eventName}\``);
    }
}

async function resetFixture(): Promise<void> {
    await dropWatchdogEvents();
    await adminConnection.query('DROP VIEW IF EXISTS migration_watchdog_bootstrap_probe');
    await adminConnection.query('DROP TRIGGER IF EXISTS migration_watchdog_persisted_probe');
    await dropProfileAccounts();
    await dropBootstrapFixture();
    await dropArmerFixture();
    await adminConnection.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        await adminConnection.query(`
            DROP TABLE IF EXISTS
                game_personal_bests,
                game_runs,
                schema_migrations,
                users
        `);
    } finally {
        await adminConnection.query('SET FOREIGN_KEY_CHECKS = 1');
    }

    await adminConnection.query(`
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
    await adminConnection.query(`
        INSERT INTO users (user_name, email, user_password, p4_score)
        VALUES
            ('alpha', 'alpha@example.test', 'test-only-hash-a', 500),
            ('beta', 'beta@example.test', 'test-only-hash-b', 900),
            ('no-score', 'none@example.test', 'test-only-hash-c', NULL)
    `);
}

async function connectAsProfile(
    profileName: MigrationPrincipalProfileName
): Promise<Connection> {
    return mysql.createConnection({
        host: config.host,
        port: config.port,
        user: getMigrationPrincipalProfile(profileName).accountName,
        password: TEST_PASSWORD,
        database: config.database,
        dateStrings: true,
        multipleStatements: false,
    });
}

async function assertLifecycleSettings(
    profileName: MigrationPrincipalProfileName
): Promise<void> {
    const { accountName } = getMigrationPrincipalProfile(profileName);
    const [rows] = await adminConnection.query<Array<RowDataPacket & {
        accountLocked: string;
        maxUserConnections: number;
        passwordLifetime: number;
    }>>(`
        SELECT
            account_locked AS accountLocked,
            max_user_connections AS maxUserConnections,
            password_lifetime AS passwordLifetime
        FROM mysql.user
        WHERE User = ? AND Host = ?
    `, [accountName, MIGRATION_PRINCIPAL_HOST]);
    assert.deepEqual(rows.map((row) => ({
        accountLocked: row.accountLocked,
        maxUserConnections: Number(row.maxUserConnections),
        passwordLifetime: Number(row.passwordLifetime),
    })), [{
        accountLocked: 'N',
        maxUserConnections: 1,
        passwordLifetime: 1,
    }]);
}

async function assertReconnectDenied(
    profileName: MigrationPrincipalProfileName
): Promise<void> {
    let unexpectedConnection: Connection | undefined;
    try {
        unexpectedConnection = await connectAsProfile(profileName);
        assert.fail(`revoked ${profileName} account unexpectedly reconnected`);
    } catch (error) {
        assert.match(
            String((error as { code?: unknown }).code),
            /^ER_(?:ACCESS_DENIED_ERROR|ACCOUNT_HAS_BEEN_LOCKED)$/u
        );
    } finally {
        if (unexpectedConnection) await unexpectedConnection.end();
    }
}

async function withTemporaryProfile(
    profileName: MigrationPrincipalProfileName,
    operation: (connection: Connection) => Promise<void>
): Promise<void> {
    await armMigrationPrincipalWatchdog(
        adminConnection,
        config.database,
        profileName,
        120,
        WATCHDOG_DEFINER
    );
    await createTemporaryMigrationPrincipal(
        adminConnection,
        config.database,
        profileName,
        TEST_PASSWORD,
        WATCHDOG_DEFINER
    );
    await assertLifecycleSettings(profileName);
    const connection = await connectAsProfile(profileName);
    try {
        await operation(connection);
    } finally {
        await connection.end();
        await revokeTemporaryMigrationPrincipal(
            adminConnection,
            config.database,
            profileName
        );
        await disarmAsBootstrap(profileName);
    }
    await assertReconnectDenied(profileName);
}

async function assertPrivilegeDenied(operation: () => Promise<unknown>): Promise<void> {
    try {
        await operation();
        assert.fail('statement unexpectedly succeeded outside the profile grant');
    } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
        const code = String((error as { code?: unknown }).code ?? '');
        assert.match(
            code,
            /^ER_(?:TABLEACCESS|COLUMNACCESS|DBACCESS|SPECIFIC_ACCESS|COMMAND)_DENIED_ERROR$/u,
            `unexpected MySQL error code ${code}`
        );
    }
}

async function assertCommonDenials(connection: Connection): Promise<void> {
    await assertPrivilegeDenied(() => connection.query('SELECT email FROM users'));
    await assertPrivilegeDenied(() => connection.query(
        `SELECT * FROM ${SENTINEL_DATABASE}.sentinel`
    ));
    await assertPrivilegeDenied(() => connection.query(
        'CREATE TABLE unauthorized_table (id INT PRIMARY KEY)'
    ));
}

async function tableCount(tableName: string): Promise<number> {
    const [rows] = await adminConnection.query<Array<RowDataPacket & {
        tableCount: number;
    }>>(`
        SELECT COUNT(*) AS tableCount
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    `, [config.database, tableName]);
    return Number(rows[0].tableCount);
}

before(async () => {
    assertSafeTestEnvironment();
    adminConnection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: process.env.MIGRATION_TEST_ROOT_USER,
        password: process.env.MIGRATION_TEST_ROOT_PASSWORD,
        database: config.database,
        dateStrings: true,
        multipleStatements: false,
    });
    await adminConnection.query(`CREATE DATABASE IF NOT EXISTS ${SENTINEL_DATABASE}`);
    await adminConnection.query(`
        CREATE TABLE IF NOT EXISTS ${SENTINEL_DATABASE}.sentinel (
            id INT NOT NULL PRIMARY KEY
        ) ENGINE = InnoDB
    `);
});

beforeEach(resetFixture);

after(async () => {
    if (!adminConnection) return;
    await dropWatchdogEvents();
    await adminConnection.query('DROP VIEW IF EXISTS migration_watchdog_bootstrap_probe');
    await adminConnection.query('DROP TRIGGER IF EXISTS migration_watchdog_persisted_probe');
    await dropProfileAccounts();
    await dropBootstrapFixture();
    await dropArmerFixture();
    await adminConnection.query(`DROP DATABASE IF EXISTS ${SENTINEL_DATABASE}`);
    await adminConnection.end();
});

async function createBootstrapFixture(includeSystemUser = true): Promise<void> {
    await adminConnection.query(
        'CREATE ROLE IF NOT EXISTS ?@?',
        [MIGRATION_PRINCIPAL_BOOTSTRAP_ROLE, MIGRATION_PRINCIPAL_HOST]
    );
    const globalPrivileges = includeSystemUser
        ? 'CREATE USER, PROCESS, SYSTEM_USER'
        : 'CREATE USER, PROCESS';
    await adminConnection.query(
        `GRANT ${globalPrivileges} ON *.* TO ?@?`,
        [MIGRATION_PRINCIPAL_BOOTSTRAP_ROLE, MIGRATION_PRINCIPAL_HOST]
    );
    await adminConnection.query(
        `GRANT ALL PRIVILEGES ON \`${TEST_DATABASE}\`.* TO ?@?`,
        [MIGRATION_PRINCIPAL_BOOTSTRAP_ROLE, MIGRATION_PRINCIPAL_HOST]
    );
    await adminConnection.query(
        'GRANT SELECT ON ?? TO ?@?',
        [`${SENTINEL_DATABASE}.sentinel`, MIGRATION_PRINCIPAL_BOOTSTRAP_ROLE,
            MIGRATION_PRINCIPAL_HOST]
    );
    await adminConnection.query(
        `CREATE USER ?@? IDENTIFIED BY ? WITH MAX_USER_CONNECTIONS 1`,
        [
            MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT,
            MIGRATION_PRINCIPAL_HOST,
            BOOTSTRAP_PASSWORD,
        ]
    );
    await adminConnection.query(
        'GRANT ?@? TO ?@?',
        [
            MIGRATION_PRINCIPAL_BOOTSTRAP_ROLE,
            MIGRATION_PRINCIPAL_HOST,
            MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT,
            MIGRATION_PRINCIPAL_HOST,
        ]
    );
    await adminConnection.query(
        'SET DEFAULT ROLE ALL TO ?@?',
        [MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT, MIGRATION_PRINCIPAL_HOST]
    );
    await adminConnection.query(
        'GRANT SELECT ON ?? TO ?@?',
        [
            `${config.database}.users`,
            MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT,
            MIGRATION_PRINCIPAL_HOST,
        ]
    );
}

async function createArmerFixture(): Promise<void> {
    await adminConnection.query(
        'CREATE USER ?@? IDENTIFIED BY ?',
        [
            MIGRATION_PRINCIPAL_WATCHDOG_ARMER_ACCOUNT,
            MIGRATION_PRINCIPAL_HOST,
            ARMER_PASSWORD,
        ]
    );
    await adminConnection.query(
        'GRANT SELECT ON mysql.user TO ?@?',
        [MIGRATION_PRINCIPAL_WATCHDOG_ARMER_ACCOUNT, MIGRATION_PRINCIPAL_HOST]
    );
    await adminConnection.query(
        `GRANT EVENT ON \`${TEST_DATABASE}\`.* TO ?@?`,
        [MIGRATION_PRINCIPAL_WATCHDOG_ARMER_ACCOUNT, MIGRATION_PRINCIPAL_HOST]
    );
}

async function connectAsArmer(): Promise<Connection> {
    return mysql.createConnection({
        host: config.host,
        port: config.port,
        user: MIGRATION_PRINCIPAL_WATCHDOG_ARMER_ACCOUNT,
        password: ARMER_PASSWORD,
        database: config.database,
        dateStrings: true,
        multipleStatements: false,
    });
}

async function connectAsBootstrap(): Promise<Connection> {
    const connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT,
        password: BOOTSTRAP_PASSWORD,
        database: config.database,
        dateStrings: true,
        multipleStatements: false,
    });
    await connection.query('SET ROLE ALL');
    return connection;
}

async function assertBootstrapReconnectDenied(): Promise<void> {
    let unexpectedConnection: Connection | undefined;
    try {
        unexpectedConnection = await connectAsBootstrap();
        assert.fail('locked bootstrap account unexpectedly reconnected');
    } catch (error) {
        assert.equal(
            (error as { code?: unknown }).code,
            'ER_ACCOUNT_HAS_BEEN_LOCKED'
        );
    } finally {
        if (unexpectedConnection) await unexpectedConnection.end();
    }
}

async function disarmAsBootstrap(
    profileName: MigrationPrincipalProfileName
): Promise<void> {
    if ((await accountState(MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT)).length === 0) {
        await createBootstrapFixture();
    }
    const bootstrapConnection = await connectAsBootstrap();
    try {
        await disarmMigrationPrincipalWatchdog(
            bootstrapConnection,
            config.database,
            profileName,
            WATCHDOG_DEFINER
        );
    } finally {
        await bootstrapConnection.end();
    }
    assert.deepEqual(
        await accountState(MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT),
        []
    );
}

async function rescheduleWatchdogNow(
    profileName: MigrationPrincipalProfileName
): Promise<void> {
    const eventName = getMigrationPrincipalWatchdogEventName(profileName);
    await adminConnection.query(`
        ALTER EVENT \`${eventName}\`
        ON SCHEDULE AT CURRENT_TIMESTAMP(6) + INTERVAL 2 SECOND
        ON COMPLETION PRESERVE
        ENABLE
    `);
}

async function waitForWatchdogAttempt(
    profileName: MigrationPrincipalProfileName
): Promise<void> {
    const eventName = getMigrationPrincipalWatchdogEventName(profileName);
    for (let attempt = 0; attempt < 80; attempt += 1) {
        const [rows] = await adminConnection.query<Array<RowDataPacket & {
            lastExecuted: string | null;
            status: string;
        }>>(`
            SELECT LAST_EXECUTED AS lastExecuted, STATUS AS status
            FROM information_schema.EVENTS
            WHERE EVENT_SCHEMA = ? AND EVENT_NAME = ?
        `, [config.database, eventName]);
        if (
            rows.length === 1
            && rows[0].lastExecuted !== null
            && rows[0].status === 'DISABLED'
        ) {
            return;
        }
        await delay(100);
    }
    assert.fail(`watchdog ${profileName} did not attempt before the test deadline`);
}

async function accountState(accountName: string): Promise<readonly {
    accountLocked: string;
}[]> {
    const [rows] = await adminConnection.query<Array<RowDataPacket & {
        accountLocked: string;
    }>>(`
        SELECT account_locked AS accountLocked
        FROM mysql.user
        WHERE User = ? AND Host = ?
    `, [accountName, MIGRATION_PRINCIPAL_HOST]);
    return rows.map(({ accountLocked }) => ({ accountLocked }));
}

test('provisioning unlocks only after grants and exact watchdog revalidation', async () => {
    const profileName = 'p4-reconcile';
    await applyMigrations(asMigrationConnection(adminConnection), migrations, config);
    await armMigrationPrincipalWatchdog(
        adminConnection,
        config.database,
        profileName,
        120,
        WATCHDOG_DEFINER
    );

    const statements: string[] = [];
    let lockedCredentialErrorCode: string | undefined;
    let accountStateDuringGrant: readonly { accountLocked: string }[] = [];
    const observedAdminConnection: MigrationPrincipalAdminConnection = {
        async query(sql: string, values: unknown[] = []): Promise<[unknown, unknown]> {
            statements.push(sql.trim().replace(/\s+/gu, ' '));
            const result = await adminConnection.query(sql, values);
            if (lockedCredentialErrorCode === undefined && sql.startsWith('GRANT ')) {
                accountStateDuringGrant = await accountState(
                    getMigrationPrincipalProfile(profileName).accountName
                );
                let unexpectedConnection: Connection | undefined;
                try {
                    unexpectedConnection = await connectAsProfile(profileName);
                    lockedCredentialErrorCode = 'CONNECTED';
                } catch (error) {
                    lockedCredentialErrorCode = String(
                        (error as { code?: unknown }).code
                    );
                } finally {
                    if (unexpectedConnection) await unexpectedConnection.end();
                }
            }
            return result as [unknown, unknown];
        },
    };

    await createTemporaryMigrationPrincipal(
        observedAdminConnection,
        config.database,
        profileName,
        TEST_PASSWORD,
        WATCHDOG_DEFINER
    );

    const metadataReads = statements
        .map((sql, index) => sql.includes('FROM information_schema.EVENTS') ? index : -1)
        .filter((index) => index >= 0);
    const createIndex = statements.findIndex((sql) => sql.startsWith('CREATE USER'));
    const grantIndexes = statements
        .map((sql, index) => sql.startsWith('GRANT ') ? index : -1)
        .filter((index) => index >= 0);
    const lastGrantIndex = grantIndexes[grantIndexes.length - 1];
    const unlockIndex = statements.findIndex((sql) =>
        sql === 'ALTER USER ?@? ACCOUNT UNLOCK'
    );
    assert.deepEqual(accountStateDuringGrant, [{ accountLocked: 'Y' }]);
    assert.equal(lockedCredentialErrorCode, 'ER_ACCOUNT_HAS_BEEN_LOCKED');
    assert.equal(metadataReads.length, 2);
    assert.match(statements[createIndex], /ACCOUNT LOCK$/u);
    assert.ok(createIndex < lastGrantIndex);
    assert.ok(lastGrantIndex < metadataReads[1]);
    assert.ok(metadataReads[1] < unlockIndex);
    assert.equal(unlockIndex, statements.length - 1);
    await assertLifecycleSettings(profileName);

    await revokeTemporaryMigrationPrincipal(
        adminConnection,
        config.database,
        profileName
    );
    await disarmAsBootstrap(profileName);
});

test('disarm locks the bootstrap before event removal and self-drops last', async () => {
    const profileName = 'schema-apply';
    await armMigrationPrincipalWatchdog(
        adminConnection,
        config.database,
        profileName,
        120,
        WATCHDOG_DEFINER
    );
    await createBootstrapFixture();
    const bootstrapConnection = await connectAsBootstrap();
    const statements: string[] = [];
    let lockedReconnectWasRejected = false;
    const observedBootstrapConnection: MigrationPrincipalAdminConnection = {
        async query(sql: string, values: unknown[] = []): Promise<[unknown, unknown]> {
            statements.push(sql.trim().replace(/\s+/gu, ' '));
            const result = await bootstrapConnection.query(sql, values);
            if (sql.startsWith('ALTER USER') && sql.includes('ACCOUNT LOCK')) {
                assert.deepEqual(
                    await accountState(MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT),
                    [{ accountLocked: 'Y' }]
                );
                await assertBootstrapReconnectDenied();
                lockedReconnectWasRejected = true;
            }
            return result as [unknown, unknown];
        },
    };

    try {
        await disarmMigrationPrincipalWatchdog(
            observedBootstrapConnection,
            config.database,
            profileName,
            WATCHDOG_DEFINER
        );
    } finally {
        await bootstrapConnection.end();
    }

    const lockIndex = statements.indexOf('ALTER USER ?@? ACCOUNT LOCK');
    const dropEventIndex = statements.findIndex((sql) => sql.startsWith('DROP EVENT'));
    const dropUserIndex = statements.indexOf('DROP USER ?@?');
    assert.equal(lockedReconnectWasRejected, true);
    assert.ok(lockIndex < dropEventIndex);
    assert.ok(dropEventIndex < dropUserIndex);
    assert.equal(dropUserIndex, statements.length - 1);
    assert.deepEqual(await accountState(MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT), []);
});

test('cms definer path disarms through a bootstrap without SYSTEM_USER', async () => {
    const profileName = 'schema-apply';
    const cmsDefiner = `${MIGRATION_PRINCIPAL_WATCHDOG_ARMER_ACCOUNT}`
        + `@${MIGRATION_PRINCIPAL_HOST}`;
    await createArmerFixture();
    const armerConnection = await connectAsArmer();
    try {
        await armMigrationPrincipalWatchdog(
            armerConnection,
            config.database,
            profileName,
            120,
            cmsDefiner
        );
    } finally {
        await armerConnection.end();
    }

    await createBootstrapFixture(false);
    const [roleGrantRows] = await adminConnection.query<RowDataPacket[]>(
        "SHOW GRANTS FOR 'cloudsqlsuperuser'@'%'"
    );
    assert.doesNotMatch(
        roleGrantRows.map((row) => Object.values(row).join(' ')).join('\n'),
        /SYSTEM_USER/u
    );
    const bootstrapConnection = await connectAsBootstrap();
    try {
        await disarmMigrationPrincipalWatchdog(
            bootstrapConnection,
            config.database,
            profileName,
            cmsDefiner
        );
    } finally {
        await bootstrapConnection.end();
    }

    assert.deepEqual(await accountState(MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT), []);
    const [eventRows] = await adminConnection.query<RowDataPacket[]>(`
        SELECT EVENT_NAME
        FROM information_schema.EVENTS
        WHERE EVENT_SCHEMA = ? AND EVENT_NAME = ?
    `, [config.database, getMigrationPrincipalWatchdogEventName(profileName)]);
    assert.deepEqual(eventRows, []);
});

test('deadline attempt locks, revokes, and drops stranded bootstrap and schema accounts', async () => {
    await armMigrationPrincipalWatchdog(
        adminConnection,
        config.database,
        'schema-apply',
        120,
        WATCHDOG_DEFINER
    );
    await createBootstrapFixture();
    await createTemporaryMigrationPrincipal(
        adminConnection,
        config.database,
        'schema-apply',
        TEST_PASSWORD,
        WATCHDOG_DEFINER
    );
    const operationConnection = await connectAsProfile('schema-apply');

    try {
        await rescheduleWatchdogNow('schema-apply');
        await waitForWatchdogAttempt('schema-apply');

        assert.deepEqual(
            await accountState(MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT),
            []
        );
        const operationState = await accountState('mickeyf_schema_apply');
        assert.ok(
            operationState.length === 0
                || (
                    operationState.length === 1
                    && operationState[0].accountLocked === 'Y'
                )
        );
        await assertReconnectDenied('schema-apply');
        await assertPrivilegeDenied(() => operationConnection.query(
            'CREATE TABLE schema_migrations (version VARCHAR(191) PRIMARY KEY)'
        ));
    } finally {
        await operationConnection.end();
    }

    for (let attempt = 0; attempt < 30; attempt += 1) {
        if ((await accountState('mickeyf_schema_apply')).length === 0) break;
        await delay(100);
    }
    assert.deepEqual(await accountState('mickeyf_schema_apply'), []);
    await disarmAsBootstrap('schema-apply');
});

test('deadline trigger refusal still drops bootstrap and leaves schema account locked and revoked', async () => {
    await armMigrationPrincipalWatchdog(
        adminConnection,
        config.database,
        'schema-apply',
        120,
        WATCHDOG_DEFINER
    );
    await createBootstrapFixture();
    await createTemporaryMigrationPrincipal(
        adminConnection,
        config.database,
        'schema-apply',
        TEST_PASSWORD,
        WATCHDOG_DEFINER
    );
    await adminConnection.query(`
        CREATE TABLE schema_migrations (
            version VARCHAR(191) NOT NULL PRIMARY KEY
        ) ENGINE = InnoDB
    `);
    await adminConnection.query(`
        CREATE DEFINER = 'mickeyf_schema_apply'@'%'
        TRIGGER migration_watchdog_persisted_probe
        BEFORE INSERT ON schema_migrations
        FOR EACH ROW SET @migration_watchdog_persisted_probe = 1
    `);

    await rescheduleWatchdogNow('schema-apply');
    await waitForWatchdogAttempt('schema-apply');

    assert.deepEqual(
        await accountState(MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT),
        []
    );
    assert.deepEqual(await accountState('mickeyf_schema_apply'), [{
        accountLocked: 'Y',
    }]);
    await assertReconnectDenied('schema-apply');
    const [grants] = await adminConnection.query<RowDataPacket[]>(
        "SHOW GRANTS FOR 'mickeyf_schema_apply'@'%'"
    );
    assert.equal(grants.length, 1);
    assert.match(String(Object.values(grants[0])[0]), /^GRANT USAGE ON \*\.\*/u);

    await adminConnection.query('DROP TRIGGER migration_watchdog_persisted_probe');
    await revokeTemporaryMigrationPrincipal(
        adminConnection,
        config.database,
        'schema-apply'
    );
    await disarmAsBootstrap('schema-apply');
});

test('deadline refuses orphaning bootstrap definers and leaves both accounts locked and revoked', async () => {
    await armMigrationPrincipalWatchdog(
        adminConnection,
        config.database,
        'schema-apply',
        120,
        WATCHDOG_DEFINER
    );
    await createBootstrapFixture();
    await createTemporaryMigrationPrincipal(
        adminConnection,
        config.database,
        'schema-apply',
        TEST_PASSWORD,
        WATCHDOG_DEFINER
    );
    await adminConnection.query(`
        CREATE DEFINER = 'mickeyf_migration_bootstrap'@'%'
        VIEW migration_watchdog_bootstrap_probe AS SELECT 1 AS probe
    `);

    await rescheduleWatchdogNow('schema-apply');
    await waitForWatchdogAttempt('schema-apply');

    assert.deepEqual(
        await accountState(MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT),
        [{ accountLocked: 'Y' }]
    );
    assert.deepEqual(
        await accountState('mickeyf_schema_apply'),
        [{ accountLocked: 'Y' }]
    );
    await assertReconnectDenied('schema-apply');
    for (const accountName of [
        MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT,
        'mickeyf_schema_apply',
    ]) {
        const [grants] = await adminConnection.query<RowDataPacket[]>(
            `SHOW GRANTS FOR '${accountName}'@'%'`
        );
        assert.equal(grants.length, 1);
        assert.match(String(Object.values(grants[0])[0]), /^GRANT USAGE ON \*\.\*/u);
    }

    await adminConnection.query('DROP VIEW migration_watchdog_bootstrap_probe');
    await revokeTemporaryMigrationPrincipal(
        adminConnection,
        config.database,
        'schema-apply'
    );
    await adminConnection.query(
        'DROP USER ?@?',
        [MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT, MIGRATION_PRINCIPAL_HOST]
    );
    await disarmAsBootstrap('schema-apply');
});

test('schema profile applies the reviewed schema and denies unrelated DDL and DML', async () => {
    await withTemporaryProfile('schema-apply', async (connection) => {
        const applied = await applyMigrations(
            asMigrationConnection(connection),
            migrations,
            config
        );
        assert.deepEqual(applied.pending, []);
        assert.deepEqual(applied.applied, migrations.map(({ version }) => version));

        await assertCommonDenials(connection);
        await assertPrivilegeDenied(() => connection.query(
            'UPDATE users SET p4_score = 1 WHERE user_id = 1'
        ));
        await assertPrivilegeDenied(() => connection.query(
            `INSERT INTO game_runs (
                game_id, rules_version, user_id, run_id, score,
                completion_time_ms, payload_fingerprint, personal_best, submitted_at
             ) VALUES (
                'three-bosses', 1, 1, '00000000-0000-4000-8000-000000000001',
                100, 1000, UNHEX(SHA2('denied', 256)), 1, UTC_TIMESTAMP(6)
             )`
        ));
        await assertPrivilegeDenied(() => connection.query('DROP TABLE game_runs'));
        await assertPrivilegeDenied(() => connection.query(
            'ALTER TABLE game_runs ADD COLUMN unauthorized INT NULL'
        ));
    });

    assert.equal(await tableCount('schema_migrations'), 1);
    assert.equal(await tableCount('game_runs'), 1);
    assert.equal(await tableCount('game_personal_bests'), 1);
});

test('backfill profile runs the real backfill and cannot widen its data changes', async () => {
    await applyMigrations(asMigrationConnection(adminConnection), migrations, config);

    await withTemporaryProfile('p4-backfill', async (connection) => {
        const result = await backfillP4VegaScores(
            asBackfillConnection(connection),
            migrations,
            config
        );
        assert.equal(result.reconciliation.consistent, true);
        assert.equal(result.reconciliation.generic.rowCount, '2');

        await assertCommonDenials(connection);
        await assertPrivilegeDenied(() => connection.query(
            'UPDATE users SET p4_score = 1 WHERE user_id = 1'
        ));
        await assertPrivilegeDenied(() => connection.query(
            `INSERT INTO game_runs (
                game_id, rules_version, user_id, run_id, score,
                completion_time_ms, payload_fingerprint, personal_best, submitted_at
             ) VALUES (
                'three-bosses', 1, 1, '00000000-0000-4000-8000-000000000002',
                100, 1000, UNHEX(SHA2('denied', 256)), 1, UTC_TIMESTAMP(6)
             )`
        ));
        await assertPrivilegeDenied(() => connection.query(
            'UPDATE game_personal_bests SET completion_time_ms = 1'
        ));
        await assertPrivilegeDenied(() => connection.query(
            'DELETE FROM game_personal_bests'
        ));
        await assertPrivilegeDenied(() => connection.query(
            'DROP TABLE game_personal_bests'
        ));
    });

    const [rows] = await adminConnection.query<RowDataPacket[]>(`
        SELECT user_id, score
        FROM game_personal_bests
        WHERE game_id = 'p4-vega'
        ORDER BY user_id
    `);
    assert.deepEqual(rows, [{ user_id: 1, score: 500 }, { user_id: 2, score: 900 }]);
});

test('reconcile profile is DML/table-DDL denied but its required TRIGGER grant is explicit', async () => {
    await applyMigrations(asMigrationConnection(adminConnection), migrations, config);
    await backfillP4VegaScores(
        asBackfillConnection(adminConnection),
        migrations,
        config
    );

    await withTemporaryProfile('p4-reconcile', async (connection) => {
        const report = await reconcileP4VegaScores(
            asBackfillConnection(connection),
            migrations,
            config
        );
        assert.equal(report.consistent, true);

        await assertCommonDenials(connection);
        await assertPrivilegeDenied(() => connection.query(
            'INSERT INTO game_personal_bests '
                + '(game_id, rules_version, user_id, score, recorded_at) '
                + "VALUES ('p4-vega', 1, 3, 1, UTC_TIMESTAMP(6))"
        ));
        await assertPrivilegeDenied(() => connection.query(
            'UPDATE game_personal_bests SET score = score + 1'
        ));
        await assertPrivilegeDenied(() => connection.query(
            'DELETE FROM game_personal_bests'
        ));
        await assertPrivilegeDenied(() => connection.query(
            'DROP TABLE game_personal_bests'
        ));

        // Without TRIGGER, MySQL hides these rows and the exact-schema verifier
        // would falsely report a clean table. The privilege also permits DROP
        // TRIGGER, so this profile is not described as strictly immutable.
        await adminConnection.query(`
            CREATE TRIGGER migration_principal_probe
            BEFORE UPDATE ON game_personal_bests
            FOR EACH ROW SET @migration_principal_probe = 1
        `);
        await assert.rejects(
            () => reconcileP4VegaScores(
                asBackfillConnection(connection),
                migrations,
                config
            ),
            /triggers does not match the reviewed migration schema/
        );
        await connection.query('DROP TRIGGER migration_principal_probe');
        const cleanReport = await reconcileP4VegaScores(
            asBackfillConnection(connection),
            migrations,
            config
        );
        assert.equal(cleanReport.consistent, true);
    });

    const [triggerRows] = await adminConnection.query<RowDataPacket[]>(`
        SELECT TRIGGER_NAME
        FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = DATABASE()
    `);
    assert.deepEqual(triggerRows, []);
});

test('rollback profile drops only an empty reviewed schema and preserves users', async () => {
    await applyMigrations(asMigrationConnection(adminConnection), migrations, config);

    await withTemporaryProfile('empty-rollback', async (connection) => {
        await assertCommonDenials(connection);
        await assertPrivilegeDenied(() => connection.query('DROP TABLE users'));
        await assertPrivilegeDenied(() => connection.query(
            `INSERT INTO schema_migrations (version, checksum, applied_at)
             VALUES ('unauthorized', UNHEX(SHA2('unauthorized', 256)), UTC_TIMESTAMP(6))`
        ));
        await assertPrivilegeDenied(() => connection.query(
            'ALTER TABLE game_runs ADD COLUMN unauthorized INT NULL'
        ));

        await rollbackEmptyLeaderboardSchema(
            asMigrationConnection(connection),
            migrations,
            config
        );
    });

    assert.equal(await tableCount('schema_migrations'), 0);
    assert.equal(await tableCount('game_runs'), 0);
    assert.equal(await tableCount('game_personal_bests'), 0);
    assert.equal(await tableCount('users'), 1);
});

test('revocation refuses an active sole session, then succeeds after it closes', async () => {
    await applyMigrations(asMigrationConnection(adminConnection), migrations, config);
    await armMigrationPrincipalWatchdog(
        adminConnection,
        config.database,
        'p4-reconcile',
        120,
        WATCHDOG_DEFINER
    );
    await createTemporaryMigrationPrincipal(
        adminConnection,
        config.database,
        'p4-reconcile',
        TEST_PASSWORD,
        WATCHDOG_DEFINER
    );
    const operationConnection = await connectAsProfile('p4-reconcile');
    try {
        let secondConnection: Connection | undefined;
        try {
            secondConnection = await connectAsProfile('p4-reconcile');
            assert.fail('MAX_USER_CONNECTIONS 1 allowed a concurrent second session');
        } catch (error) {
            assert.equal((error as { code?: unknown }).code, 'ER_USER_LIMIT_REACHED');
        } finally {
            if (secondConnection) await secondConnection.end();
        }

        await assert.rejects(
            () => revokeTemporaryMigrationPrincipal(
                adminConnection,
                config.database,
                'p4-reconcile'
            ),
            ActiveMigrationPrincipalConnectionsError
        );
        await assertReconnectDenied('p4-reconcile');
        await assertPrivilegeDenied(() => operationConnection.query(
            'SELECT version FROM schema_migrations'
        ));
    } finally {
        await operationConnection.end();
    }

    await revokeTemporaryMigrationPrincipal(
        adminConnection,
        config.database,
        'p4-reconcile'
    );
    await assertReconnectDenied('p4-reconcile');
    await disarmAsBootstrap('p4-reconcile');
});

test('persisted trigger inventory blocks account removal until an operator cleans it', async () => {
    await applyMigrations(asMigrationConnection(adminConnection), migrations, config);
    await backfillP4VegaScores(
        asBackfillConnection(adminConnection),
        migrations,
        config
    );
    await armMigrationPrincipalWatchdog(
        adminConnection,
        config.database,
        'p4-reconcile',
        120,
        WATCHDOG_DEFINER
    );
    await createTemporaryMigrationPrincipal(
        adminConnection,
        config.database,
        'p4-reconcile',
        TEST_PASSWORD,
        WATCHDOG_DEFINER
    );
    const operationConnection = await connectAsProfile('p4-reconcile');
    await reconcileP4VegaScores(
        asBackfillConnection(operationConnection),
        migrations,
        config
    );
    await operationConnection.end();

    await adminConnection.query(`
        CREATE DEFINER = 'mickeyf_p4_reconcile'@'%'
        TRIGGER migration_principal_persisted_probe
        BEFORE UPDATE ON game_personal_bests
        FOR EACH ROW SET @migration_principal_persisted_probe = 1
    `);
    try {
        await assert.rejects(
            () => revokeTemporaryMigrationPrincipal(
                adminConnection,
                config.database,
                'p4-reconcile'
            ),
            UnexpectedMigrationTriggerError
        );
        await assertReconnectDenied('p4-reconcile');
    } finally {
        await adminConnection.query(
            'DROP TRIGGER IF EXISTS migration_principal_persisted_probe'
        );
    }

    await revokeTemporaryMigrationPrincipal(
        adminConnection,
        config.database,
        'p4-reconcile'
    );
    await assertReconnectDenied('p4-reconcile');
    await disarmAsBootstrap('p4-reconcile');
});
