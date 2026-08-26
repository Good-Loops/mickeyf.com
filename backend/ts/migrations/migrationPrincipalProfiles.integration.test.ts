import assert from 'node:assert/strict';
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
    revokeTemporaryMigrationPrincipal,
    UnexpectedMigrationTriggerError,
} from './migrationPrincipalManager';
import {
    getMigrationPrincipalProfile,
    MIGRATION_PRINCIPAL_HOST,
    MIGRATION_PRINCIPAL_PROFILE_NAMES,
    type MigrationPrincipalProfileName,
} from './migrationPrincipalProfiles';
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

async function resetFixture(): Promise<void> {
    await dropProfileAccounts();
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
    await createTemporaryMigrationPrincipal(
        adminConnection,
        config.database,
        profileName,
        TEST_PASSWORD
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
    await dropProfileAccounts();
    await adminConnection.query(`DROP DATABASE IF EXISTS ${SENTINEL_DATABASE}`);
    await adminConnection.end();
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
    await createTemporaryMigrationPrincipal(
        adminConnection,
        config.database,
        'p4-reconcile',
        TEST_PASSWORD
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
});

test('persisted trigger inventory blocks account removal until an operator cleans it', async () => {
    await applyMigrations(asMigrationConnection(adminConnection), migrations, config);
    await backfillP4VegaScores(
        asBackfillConnection(adminConnection),
        migrations,
        config
    );
    await createTemporaryMigrationPrincipal(
        adminConnection,
        config.database,
        'p4-reconcile',
        TEST_PASSWORD
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
});
