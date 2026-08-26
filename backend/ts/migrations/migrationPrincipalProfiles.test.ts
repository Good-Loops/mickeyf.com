import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    ActiveMigrationPrincipalConnectionsError,
    createTemporaryMigrationPrincipal,
    MigrationPrincipalProvisioningError,
    revokeTemporaryMigrationPrincipal,
    type MigrationPrincipalAdminConnection,
} from './migrationPrincipalManager';
import {
    buildMigrationPrincipalGrantStatements,
    getMigrationPrincipalProfile,
    MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT,
    MIGRATION_PRINCIPAL_HOST,
    MIGRATION_PRINCIPAL_PROFILE_NAMES,
    MIGRATION_PRINCIPAL_WATCHDOG_ARMER_ACCOUNT,
} from './migrationPrincipalProfiles';
import {
    buildMigrationPrincipalWatchdogBody,
    getMigrationPrincipalWatchdogEventName,
} from './migrationPrincipalWatchdog';

const DATABASE = 'mickeyf_migration_test';
const TEST_PASSWORD = 'test-only-0123456789abcdef0123456789';
const WATCHDOG_DEFINER = 'root@%';

type QueryCall = Readonly<{ sql: string; values: readonly unknown[] }>;

class FakeAdminConnection implements MigrationPrincipalAdminConnection {
    readonly calls: QueryCall[] = [];
    activeConnections = 0;
    mandatoryRoles = '';
    unexpectedTriggers = 0;
    watchdogPresent = true;
    watchdogSecondsUntilExecution = 119;
    failGrantNumber?: number;
    failCreate = false;
    private grantsSeen = 0;

    async query(sql: string, values: unknown[] = []): Promise<[unknown, unknown]> {
        this.calls.push(Object.freeze({ sql, values: Object.freeze([...values]) }));
        if (sql.startsWith('CREATE USER') && this.failCreate) {
            throw new Error('test-only create failure');
        }
        if (sql.startsWith('GRANT ')) {
            this.grantsSeen += 1;
            if (this.grantsSeen === this.failGrantNumber) {
                throw new Error('test-only grant failure');
            }
        }
        if (sql.includes('information_schema.PROCESSLIST')) {
            return [[{ activeConnectionCount: this.activeConnections }], []];
        }
        if (sql.includes('@@GLOBAL.event_scheduler')) {
            return [[{
                eventScheduler: 'ON',
                currentUser: 'migration_principal_admin@%',
            }], []];
        }
        if (sql.includes('FROM mysql.user')) {
            return [[{ accountCount: values[0] === 'root' ? 1 : 0 }], []];
        }
        if (sql.includes('FROM information_schema.EVENTS')) {
            if (!this.watchdogPresent) return [[], []];
            const eventName = String(values[1]);
            const profileName = MIGRATION_PRINCIPAL_PROFILE_NAMES.find(
                (name) => getMigrationPrincipalWatchdogEventName(name) === eventName
            );
            assert.ok(profileName);
            return [[{
                eventSchema: DATABASE,
                eventName,
                definer: 'root@%',
                timeZone: '+00:00',
                eventBody: 'SQL',
                eventDefinition: buildMigrationPrincipalWatchdogBody(
                    DATABASE,
                    profileName
                ),
                sqlMode: 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION',
                eventType: 'ONE TIME',
                executeAt: '2026-08-26 12:00:00',
                status: 'ENABLED',
                onCompletion: 'PRESERVE',
                eventComment: `mickeyf migration watchdog v1 ${profileName}`,
                lastExecuted: null,
                secondsUntilExecution: this.watchdogSecondsUntilExecution,
            }], []];
        }
        if (sql.includes('@@GLOBAL.mandatory_roles')) {
            return [[{ mandatoryRoles: this.mandatoryRoles }], []];
        }
        if (sql.includes('information_schema.TRIGGERS')) {
            return [[{ unexpectedTriggerCount: this.unexpectedTriggers }], []];
        }
        return [{}, []];
    }
}

test('profiles expose fixed account identities and exact allowlisted grants', () => {
    assert.equal(MIGRATION_PRINCIPAL_HOST, '%');
    assert.equal(MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT, 'mickeyf_migration_bootstrap');
    assert.equal(MIGRATION_PRINCIPAL_WATCHDOG_ARMER_ACCOUNT, 'cms_mickeyf');
    assert.deepEqual(MIGRATION_PRINCIPAL_PROFILE_NAMES, [
        'schema-apply',
        'p4-backfill',
        'p4-reconcile',
        'empty-rollback',
    ]);
    assert.deepEqual(
        MIGRATION_PRINCIPAL_PROFILE_NAMES.map((name) =>
            getMigrationPrincipalProfile(name).accountName
        ),
        [
            'mickeyf_schema_apply',
            'mickeyf_p4_backfill',
            'mickeyf_p4_reconcile',
            'mickeyf_empty_rollback',
        ]
    );

    assert.deepEqual(
        buildMigrationPrincipalGrantStatements(DATABASE, 'schema-apply'),
        [
            'GRANT CREATE, SELECT, INSERT, TRIGGER '
                + 'ON `mickeyf_migration_test`.`schema_migrations` TO ?@?',
            'GRANT CREATE, REFERENCES, TRIGGER '
                + 'ON `mickeyf_migration_test`.`game_runs` TO ?@?',
            'GRANT CREATE, REFERENCES, TRIGGER '
                + 'ON `mickeyf_migration_test`.`game_personal_bests` TO ?@?',
            'GRANT REFERENCES '
                + 'ON `mickeyf_migration_test`.`users` TO ?@?',
        ]
    );
    assert.match(
        buildMigrationPrincipalGrantStatements(DATABASE, 'p4-backfill').join('\n'),
        /UPDATE \(score, recorded_at\)/
    );
    assert.doesNotMatch(
        buildMigrationPrincipalGrantStatements(DATABASE, 'p4-reconcile').join('\n'),
        /INSERT|UPDATE|DELETE|CREATE|DROP|ALTER/u
    );
    assert.match(
        buildMigrationPrincipalGrantStatements(DATABASE, 'empty-rollback')[0],
        /^GRANT LOCK TABLES ON `mickeyf_migration_test`\.\* TO \?@\?$/u
    );
});

test('database identifiers are escaped only after strict validation', () => {
    assert.deepEqual(
        buildMigrationPrincipalGrantStatements('cms-mickeyf', 'p4-reconcile')[0],
        'GRANT SELECT, TRIGGER '
            + 'ON `cms-mickeyf`.`schema_migrations` TO ?@?'
    );
    for (const unsafeName of ['', 'db.name', 'db`name', 'db name', 'db;DROP']) {
        assert.throws(
            () => buildMigrationPrincipalGrantStatements(unsafeName, 'schema-apply'),
            /database name must contain only/
        );
    }
});

test('create parameterizes the account and password and applies every fixed grant', async () => {
    const connection = new FakeAdminConnection();
    await createTemporaryMigrationPrincipal(
        connection,
        DATABASE,
        'p4-reconcile',
        TEST_PASSWORD,
        WATCHDOG_DEFINER
    );

    const mandatoryRoleCall = connection.calls.find(({ sql }) =>
        sql.includes('@@GLOBAL.mandatory_roles')
    );
    const createCall = connection.calls.find(({ sql }) => sql.startsWith('CREATE USER'));
    const grantCalls = connection.calls.filter(({ sql }) => sql.startsWith('GRANT '));
    const watchdogMetadataCallIndexes = connection.calls
        .map(({ sql }, index) => sql.includes('FROM information_schema.EVENTS')
            ? index
            : -1)
        .filter((index) => index >= 0);
    const createCallIndex = connection.calls.findIndex(({ sql }) =>
        sql.startsWith('CREATE USER')
    );
    const grantCallIndexes = connection.calls
        .map(({ sql }, index) => sql.startsWith('GRANT ') ? index : -1)
        .filter((index) => index >= 0);
    const lastGrantCallIndex = grantCallIndexes[grantCallIndexes.length - 1];
    const unlockCallIndex = connection.calls.findIndex(({ sql }) =>
        sql.startsWith('ALTER USER') && sql.includes('ACCOUNT UNLOCK')
    );
    assert.ok(mandatoryRoleCall);
    assert.ok(createCall);
    assert.match(mandatoryRoleCall.sql, /@@GLOBAL\.mandatory_roles/u);
    assert.match(createCall.sql, /^CREATE USER \?@\?/u);
    assert.match(createCall.sql, /ACCOUNT LOCK$/u);
    assert.doesNotMatch(createCall.sql, new RegExp(TEST_PASSWORD, 'u'));
    assert.deepEqual(createCall.values, [
        'mickeyf_p4_reconcile',
        '%',
        TEST_PASSWORD,
    ]);
    assert.equal(
        grantCalls.length,
        buildMigrationPrincipalGrantStatements(DATABASE, 'p4-reconcile').length
    );
    assert.equal(grantCalls.every(({ sql }) => sql.endsWith('TO ?@?')), true);
    assert.equal(
        grantCalls.every(({ values }) =>
            JSON.stringify(values) === JSON.stringify(['mickeyf_p4_reconcile', '%'])
        ),
        true
    );
    assert.deepEqual(watchdogMetadataCallIndexes.length, 2);
    assert.ok(createCallIndex < lastGrantCallIndex);
    assert.ok(lastGrantCallIndex < watchdogMetadataCallIndexes[1]);
    assert.ok(watchdogMetadataCallIndexes[1] < unlockCallIndex);
    assert.equal(unlockCallIndex, connection.calls.length - 1);
});

test('partial provisioning locks, revokes, and drops the incomplete account', async () => {
    const connection = new FakeAdminConnection();
    connection.failGrantNumber = 2;

    await assert.rejects(
        () => createTemporaryMigrationPrincipal(
            connection,
            DATABASE,
            'schema-apply',
            TEST_PASSWORD,
            WATCHDOG_DEFINER
        ),
        (error: unknown) => {
            assert.ok(error instanceof MigrationPrincipalProvisioningError);
            assert.match(error.message, /failed and was removed/);
            return true;
        }
    );
    const sql = connection.calls.map(({ sql: statement }) => statement).join('\n');
    assert.match(sql, /ALTER USER \?@\? ACCOUNT LOCK/u);
    assert.match(sql, /REVOKE ALL PRIVILEGES, GRANT OPTION FROM \?@\?/u);
    assert.match(sql, /DROP USER \?@\?/u);
    assert.doesNotMatch(sql, new RegExp(TEST_PASSWORD, 'u'));
});

test('CREATE USER failure does not claim that a nonexistent account was removed', async () => {
    const connection = new FakeAdminConnection();
    connection.failCreate = true;

    await assert.rejects(
        () => createTemporaryMigrationPrincipal(
            connection,
            DATABASE,
            'schema-apply',
            TEST_PASSWORD,
            WATCHDOG_DEFINER
        ),
        (error: unknown) => {
            assert.ok(error instanceof MigrationPrincipalProvisioningError);
            assert.match(error.message, /failed before account creation/);
            assert.doesNotMatch(error.message, /was removed/);
            return true;
        }
    );
    assert.equal(
        connection.calls.some(({ sql }) => sql.startsWith('ALTER USER')),
        false
    );
});

test('provisioning refuses inherited mandatory roles before account creation', async () => {
    const connection = new FakeAdminConnection();
    connection.mandatoryRoles = '`unexpected_role`@`%`';

    await assert.rejects(
        () => createTemporaryMigrationPrincipal(
            connection,
            DATABASE,
            'p4-reconcile',
            TEST_PASSWORD,
            WATCHDOG_DEFINER
        ),
        /mandatory_roles to be empty/
    );
    assert.equal(connection.calls.some(({ sql }) => sql.startsWith('CREATE USER')), false);
});

test('create refuses to provision any account without its exact armed watchdog', async () => {
    const connection = new FakeAdminConnection();
    connection.watchdogPresent = false;

    await assert.rejects(
        () => createTemporaryMigrationPrincipal(
            connection,
            DATABASE,
            'schema-apply',
            TEST_PASSWORD,
            WATCHDOG_DEFINER
        ),
        /requires an armed watchdog/
    );
    assert.equal(
        connection.calls.some(({ sql }) => sql.startsWith('CREATE USER')),
        false
    );
});

test('revocation locks first and refuses to drop an account with an open session', async () => {
    const connection = new FakeAdminConnection();
    connection.activeConnections = 1;

    await assert.rejects(
        () => revokeTemporaryMigrationPrincipal(connection, DATABASE, 'p4-backfill'),
        ActiveMigrationPrincipalConnectionsError
    );
    assert.match(connection.calls[0].sql, /^ALTER USER \?@\? ACCOUNT LOCK$/u);
    assert.equal(
        connection.calls.some(({ sql }) => sql.startsWith('REVOKE ALL PRIVILEGES')),
        true
    );
    assert.equal(
        connection.calls.some(({ sql }) => sql.startsWith('DROP USER')),
        false
    );
});

test('idle revocation locks, checks, revokes, and drops in that order', async () => {
    const connection = new FakeAdminConnection();
    await revokeTemporaryMigrationPrincipal(connection, DATABASE, 'empty-rollback');

    assert.deepEqual(
        connection.calls.map(({ sql }) => sql.trim().split(/\s+/u).join(' ')),
        [
            'ALTER USER ?@? ACCOUNT LOCK',
            'REVOKE ALL PRIVILEGES, GRANT OPTION FROM ?@?',
            'SELECT COUNT(*) AS activeConnectionCount FROM '
                + 'information_schema.PROCESSLIST WHERE USER = ?',
            'SELECT COUNT(*) AS unexpectedTriggerCount FROM '
                + 'information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? '
                + 'AND EVENT_OBJECT_TABLE IN (?, ?, ?)',
            'DROP USER ?@?',
        ]
    );
});
