import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    armMigrationPrincipalWatchdog,
    assertMigrationPrincipalWatchdogDelay,
    assertMigrationPrincipalWatchdogReady,
    buildMigrationPrincipalWatchdogBody,
    disarmMigrationPrincipalWatchdog,
    getMigrationPrincipalWatchdogEventName,
    type MigrationPrincipalWatchdogConnection,
} from './migrationPrincipalWatchdog';

const DATABASE = 'mickeyf_migration_test';
const PROFILE = 'schema-apply' as const;
const DEFINER = 'root@%';

type QueryCall = Readonly<{ sql: string; values: readonly unknown[] }>;

class FakeWatchdogConnection implements MigrationPrincipalWatchdogConnection {
    readonly calls: QueryCall[] = [];
    scheduler = 'ON';
    accountCount = 0;
    eventExists = false;
    eventStatus = 'ENABLED';
    eventExecuted = false;
    secondsUntilExecution = 119;
    eventComment = 'mickeyf migration watchdog v1 schema-apply';
    eventDefinition = buildMigrationPrincipalWatchdogBody(DATABASE, PROFILE);
    eventDefiner = 'root@%';
    rootAccountCount = 1;
    bootstrapDefinerObjectCount = 0;
    currentUser = 'migration_admin@%';

    async query(sql: string, values: unknown[] = []): Promise<[unknown, unknown]> {
        this.calls.push(Object.freeze({ sql, values: Object.freeze([...values]) }));
        if (sql.startsWith('CREATE DEFINER')) {
            this.eventExists = true;
            return [{}, []];
        }
        if (sql.startsWith('DROP EVENT')) {
            this.eventExists = false;
            return [{}, []];
        }
        if (sql.includes('@@GLOBAL.event_scheduler')) {
            return [[{
                eventScheduler: this.scheduler,
                currentUser: this.currentUser,
            }], []];
        }
        if (sql.includes('FROM mysql.user')) {
            return [[{
                accountCount: values[0] === 'root'
                    ? this.rootAccountCount
                    : this.accountCount,
            }], []];
        }
        if (sql.includes('AS bootstrapDefinerObjectCount')) {
            return [[{
                bootstrapDefinerObjectCount: this.bootstrapDefinerObjectCount,
            }], []];
        }
        if (sql.includes('FROM information_schema.EVENTS')) {
            if (!this.eventExists) return [[], []];
            return [[{
                eventSchema: DATABASE,
                eventName: getMigrationPrincipalWatchdogEventName(PROFILE),
                definer: this.eventDefiner,
                timeZone: '+00:00',
                eventBody: 'SQL',
                eventDefinition: this.eventDefinition,
                sqlMode: 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION',
                eventType: 'ONE TIME',
                executeAt: '2026-08-26 12:00:00',
                status: this.eventStatus,
                onCompletion: 'PRESERVE',
                eventComment: this.eventComment,
                lastExecuted: this.eventExecuted ? '2026-08-26 12:00:00' : null,
                secondsUntilExecution: this.secondsUntilExecution,
            }], []];
        }
        return [{}, []];
    }
}

test('watchdog events and bodies are fixed per allowlisted profile', () => {
    assert.deepEqual([
        getMigrationPrincipalWatchdogEventName('schema-apply'),
        getMigrationPrincipalWatchdogEventName('p4-backfill'),
        getMigrationPrincipalWatchdogEventName('p4-reconcile'),
        getMigrationPrincipalWatchdogEventName('empty-rollback'),
    ], [
        'mickeyf_watchdog_schema_apply',
        'mickeyf_watchdog_p4_backfill',
        'mickeyf_watchdog_p4_reconcile',
        'mickeyf_watchdog_empty_rollback',
    ]);

    const body = buildMigrationPrincipalWatchdogBody(DATABASE, PROFILE);
    assert.match(body, /REVOKE IF EXISTS ALL PRIVILEGES, GRANT OPTION/u);
    assert.match(
        body,
        /REVOKE IF EXISTS 'cloudsqlsuperuser'@'%'\s+FROM 'mickeyf_migration_bootstrap'@'%' IGNORE UNKNOWN USER/u
    );
    assert.match(
        body,
        /DROP USER IF EXISTS 'mickeyf_migration_bootstrap'@'%'/u
    );
    assert.match(body, /ALTER USER 'mickeyf_migration_bootstrap'@'%' ACCOUNT LOCK/u);
    assert.match(body, /ALTER USER 'mickeyf_schema_apply'@'%' ACCOUNT LOCK/u);
    for (const metadataTable of ['EVENTS', 'ROUTINES', 'TRIGGERS', 'VIEWS']) {
        assert.match(
            body,
            new RegExp(`information_schema\\.${metadataTable}`, 'u')
        );
    }
    assert.match(body, /Migration watchdog found bootstrap definer objects/u);
    assert.match(body, /'mickeyf_schema_apply'@'%'/u);
    assert.match(body, /'schema_migrations', 'game_runs', 'game_personal_bests'/u);
    assert.match(body, /DROP USER IF EXISTS 'mickeyf_schema_apply'@'%'/u);
    assert.ok(
        body.indexOf("DROP USER IF EXISTS 'mickeyf_migration_bootstrap'@'%'")
            < body.indexOf('IF unexpectedTriggerCount = 0')
    );
});

test('watchdog delays are strictly bounded', () => {
    for (const accepted of [120, 600, 1_800]) {
        assert.doesNotThrow(() => assertMigrationPrincipalWatchdogDelay(accepted));
    }
    for (const rejected of [0, 119, 1_801, 120.5, Number.NaN]) {
        assert.throws(
            () => assertMigrationPrincipalWatchdogDelay(rejected),
            /120 through 1800/
        );
    }
});

test('arm uses an explicit definer and a bounded server-time schedule', async () => {
    const connection = new FakeWatchdogConnection();
    const state = await armMigrationPrincipalWatchdog(
        connection,
        DATABASE,
        PROFILE,
        120,
        DEFINER
    );

    assert.equal(state.status, 'ENABLED');
    assert.equal(state.attempted, false);
    assert.equal(state.executeAtUtc, '2026-08-26T12:00:00Z');
    const create = connection.calls.find(({ sql }) => sql.startsWith('CREATE DEFINER'));
    assert.ok(create);
    assert.match(create.sql, /CREATE DEFINER = 'root'@'%'/u);
    assert.match(
        create.sql,
        /ON SCHEDULE AT CURRENT_TIMESTAMP\(6\) \+ INTERVAL 120 SECOND/u
    );
    assert.doesNotMatch(create.sql, /2026-|Date|UTC_TIMESTAMP/u);
    const createIndex = connection.calls.indexOf(create);
    assert.ok(connection.calls.slice(0, createIndex).some(({ sql }) =>
        sql === "SET SESSION time_zone = '+00:00'"
    ));
    assert.ok(connection.calls.slice(0, createIndex).some(({ sql, values }) =>
        sql === 'SET SESSION sql_mode = ?'
            && values[0]
                === 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'
    ));
});

test('arm refuses a disabled scheduler, existing account, or existing event', async () => {
    const disabled = new FakeWatchdogConnection();
    disabled.scheduler = 'OFF';
    await assert.rejects(
        () => armMigrationPrincipalWatchdog(disabled, DATABASE, PROFILE, 120, DEFINER),
        /Event Scheduler must be ON/
    );

    const accountExists = new FakeWatchdogConnection();
    accountExists.accountCount = 1;
    await assert.rejects(
        () => armMigrationPrincipalWatchdog(
            accountExists,
            DATABASE,
            PROFILE,
            120,
            DEFINER
        ),
        /before the temporary account exists/
    );

    const eventExists = new FakeWatchdogConnection();
    eventExists.eventExists = true;
    await assert.rejects(
        () => armMigrationPrincipalWatchdog(
            eventExists,
            DATABASE,
            PROFILE,
            120,
            DEFINER
        ),
        /already exists/
    );

    const missingDefiner = new FakeWatchdogConnection();
    missingDefiner.rootAccountCount = 0;
    await assert.rejects(
        () => armMigrationPrincipalWatchdog(
            missingDefiner,
            DATABASE,
            PROFILE,
            120,
            DEFINER
        ),
        /definer must exist exactly once/
    );
    await assert.rejects(
        () => armMigrationPrincipalWatchdog(
            new FakeWatchdogConnection(),
            DATABASE,
            PROFILE,
            120,
            'arbitrary@%'
        ),
        /not in the reviewed allowlist/
    );
});

test('ready requires an exact, future, unexecuted watchdog', async () => {
    const connection = new FakeWatchdogConnection();
    connection.eventExists = true;
    await assert.doesNotReject(() => assertMigrationPrincipalWatchdogReady(
        connection,
        DATABASE,
        PROFILE,
        DEFINER
    ));

    connection.eventDefiner = 'other@%';
    await assert.rejects(
        () => assertMigrationPrincipalWatchdogReady(
            connection,
            DATABASE,
            PROFILE,
            DEFINER
        ),
        /does not match/
    );
    connection.eventDefiner = 'root@%';
    connection.secondsUntilExecution = 59;
    await assert.rejects(
        () => assertMigrationPrincipalWatchdogReady(
            connection,
            DATABASE,
            PROFILE,
            DEFINER
        ),
        /deadline is not safe/
    );
});

test('disarm verifies exact ownership before dropping and proves absence', async () => {
    const connection = new FakeWatchdogConnection();
    connection.currentUser = 'mickeyf_migration_bootstrap@%';
    connection.eventExists = true;
    await disarmMigrationPrincipalWatchdog(
        connection,
        DATABASE,
        PROFILE,
        DEFINER
    );
    assert.equal(connection.eventExists, false);
    assert.equal(
        connection.calls.filter(({ sql }) => sql.startsWith('DROP EVENT')).length,
        1
    );
    const normalizedStatements = connection.calls.map(({ sql }) =>
        sql.trim().replace(/\s+/gu, ' ')
    );
    const definerAuditIndex = normalizedStatements.findIndex((sql) =>
        sql.includes('AS bootstrapDefinerObjectCount')
    );
    const lockIndex = normalizedStatements.indexOf('ALTER USER ?@? ACCOUNT LOCK');
    const dropEventIndex = normalizedStatements.findIndex((sql) =>
        sql.startsWith('DROP EVENT')
    );
    const dropUserIndex = normalizedStatements.indexOf('DROP USER ?@?');
    assert.ok(definerAuditIndex < lockIndex);
    assert.ok(lockIndex < dropEventIndex);
    assert.ok(dropEventIndex < dropUserIndex);
    assert.equal(dropUserIndex, normalizedStatements.length - 1);

    const foreign = new FakeWatchdogConnection();
    foreign.currentUser = 'mickeyf_migration_bootstrap@%';
    foreign.eventExists = true;
    foreign.eventComment = 'foreign event';
    await assert.rejects(
        () => disarmMigrationPrincipalWatchdog(
            foreign,
            DATABASE,
            PROFILE,
            DEFINER
        ),
        /does not match/
    );
    assert.equal(
        foreign.calls.some(({ sql }) => sql.startsWith('DROP EVENT')),
        false
    );
    assert.equal(
        foreign.calls.some(({ sql }) => sql.startsWith('ALTER USER')),
        true
    );
    assert.equal(
        foreign.calls.some(({ sql }) => sql.startsWith('DROP USER')),
        false
    );

    const ownedObject = new FakeWatchdogConnection();
    ownedObject.currentUser = 'mickeyf_migration_bootstrap@%';
    ownedObject.eventExists = true;
    ownedObject.bootstrapDefinerObjectCount = 1;
    await assert.rejects(
        () => disarmMigrationPrincipalWatchdog(
            ownedObject,
            DATABASE,
            PROFILE,
            DEFINER
        ),
        /refused 1 bootstrap definer object/
    );
    assert.equal(
        ownedObject.calls.some(({ sql }) => sql.startsWith('ALTER USER')),
        false
    );

    const wrongIdentity = new FakeWatchdogConnection();
    wrongIdentity.eventExists = true;
    await assert.rejects(
        () => disarmMigrationPrincipalWatchdog(
            wrongIdentity,
            DATABASE,
            PROFILE,
            DEFINER
        ),
        /unexpected account/
    );
    assert.equal(
        wrongIdentity.calls.some(({ sql }) => sql.startsWith('ALTER USER')),
        false
    );
});

test('failed post-create verification removes only the event just created', async () => {
    const connection = new FakeWatchdogConnection();
    connection.eventDefinition = 'DO SOMETHING ELSE';
    await assert.rejects(
        () => armMigrationPrincipalWatchdog(
            connection,
            DATABASE,
            PROFILE,
            120,
            DEFINER
        ),
        /does not match/
    );
    assert.equal(connection.eventExists, false);
    assert.equal(
        connection.calls.some(({ sql }) => sql.startsWith('DROP EVENT')),
        true
    );
});
