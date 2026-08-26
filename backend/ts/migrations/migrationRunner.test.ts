import assert from 'node:assert/strict';
import test from 'node:test';
import type { MigrationConnection } from './leaderboardSchema';
import { loadMigrationManifest } from './migrationManifest';
import {
    applyMigrations,
    migrationLockName,
    planMigrations,
} from './migrationRunner';

type QueryResultFactory = (
    sql: string,
    values: unknown[]
) => unknown;

class FakeConnection implements MigrationConnection {
    readonly calls: Array<{ sql: string; values: unknown[] }> = [];
    destroyed = false;

    constructor(private readonly resultFactory: QueryResultFactory) {}

    async query(sql: string, values: unknown[] = []): Promise<[unknown, unknown]> {
        this.calls.push({ sql, values });
        return [this.resultFactory(sql, values), []];
    }

    destroy(): void {
        this.destroyed = true;
    }
}

const settings = {
    database: 'migration_test',
    advisoryLockTimeoutSeconds: 2,
    lockWaitTimeoutSeconds: 7,
};

const exactP4ScoreColumn = Object.freeze({
    name: 'p4_score',
    type: 'int',
    nullable: 'YES',
    characterSet: null,
    collation: null,
    defaultValue: null,
    extra: '',
    comment: '',
    generationExpression: '',
});

type FakeMigrationState = {
    historyExists: boolean;
    appliedRows: Array<{ version: string; checksum: Buffer }>;
    p4ScoreColumn: typeof exactP4ScoreColumn | null;
    p4IndexDependencies?: Array<{ name: string }>;
};

function migrationResults(state: FakeMigrationState): QueryResultFactory {
    return (sql, values) => {
        if (sql.includes('GET_LOCK')) return [{ acquired: 1 }];
        if (sql.includes('RELEASE_LOCK')) return [{ released: 1 }];

        if (sql.includes('COUNT(*)') && sql.includes('information_schema.TABLES')) {
            const tableName = values[0];
            return [{
                tableCount: tableName === 'schema_migrations' && state.historyExists ? 1 : 0,
            }];
        }
        if (/CREATE TABLE schema_migrations/u.test(sql)) {
            state.historyExists = true;
            return {};
        }

        if (sql.includes('SELECT ENGINE AS engine') && sql.includes('TABLE_COLLATION')) {
            return [{ engine: 'InnoDB', tableCollation: 'utf8mb4_unicode_ci' }];
        }
        if (sql.includes('SELECT ENGINE AS engine') && sql.includes("TABLE_NAME = 'users'")) {
            return [{ engine: 'InnoDB' }];
        }

        if (sql.includes('information_schema.COLUMNS') && values[0] === 'schema_migrations') {
            return [
                {
                    name: 'version',
                    type: 'varchar(128)',
                    nullable: 'NO',
                    characterSet: 'ascii',
                    collation: 'ascii_bin',
                    extra: '',
                    datetimePrecision: null,
                    defaultValue: null,
                    comment: '',
                },
                {
                    name: 'checksum',
                    type: 'binary(32)',
                    nullable: 'NO',
                    characterSet: null,
                    collation: null,
                    extra: '',
                    datetimePrecision: null,
                    defaultValue: null,
                    comment: '',
                },
                {
                    name: 'applied_at',
                    type: 'datetime(6)',
                    nullable: 'NO',
                    characterSet: null,
                    collation: null,
                    extra: '',
                    datetimePrecision: 6,
                    defaultValue: null,
                    comment: 'UTC',
                },
            ];
        }
        if (
            sql.includes('information_schema.COLUMNS')
            && sql.includes("COLUMN_NAME = 'p4_score'")
        ) {
            return state.p4ScoreColumn ? [state.p4ScoreColumn] : [];
        }
        if (sql.includes('GENERATION_EXPRESSION <>')) return [];

        if (sql.includes('information_schema.STATISTICS') && values[0] === 'schema_migrations') {
            return [{
                name: 'PRIMARY',
                nonUnique: 0,
                sequence: 1,
                columnName: 'version',
                indexOrder: 'A',
                subPart: null,
                visible: 'YES',
                indexType: 'BTREE',
            }];
        }
        if (
            sql.includes('information_schema.STATISTICS')
            && sql.includes("COLUMN_NAME = 'p4_score'")
        ) {
            return state.p4IndexDependencies ?? [];
        }

        if (sql.includes('information_schema.KEY_COLUMN_USAGE')) return [];
        if (sql.includes('information_schema.TABLE_CONSTRAINTS')) return [];
        if (sql.includes('information_schema.TRIGGERS')) return [];
        if (sql.includes('information_schema.VIEWS')) return [];
        if (sql.includes('information_schema.ROUTINES')) return [];
        if (sql.includes('information_schema.EVENTS')) return [];

        if (sql.includes('FROM schema_migrations')) return state.appliedRows;
        if (sql.includes('INSERT INTO schema_migrations')) {
            state.appliedRows.push({
                version: values[0] as string,
                checksum: values[1] as Buffer,
            });
            return {};
        }
        if (sql.trim() === 'ALTER TABLE users DROP COLUMN p4_score, ALGORITHM=INSTANT;') {
            state.p4ScoreColumn = null;
            return {};
        }

        return {};
    };
}

function legacySourceState(): FakeMigrationState {
    return {
        historyExists: false,
        appliedRows: [],
        p4ScoreColumn: exactP4ScoreColumn,
    };
}

test('plan is read-only, configures short waits, and releases its advisory lock', async () => {
    const connection = new FakeConnection(migrationResults(legacySourceState()));
    const migrations = loadMigrationManifest();

    const plan = await planMigrations(connection, migrations, settings);

    assert.deepEqual(plan, {
        applied: [],
        pending: [
            '0001_create_game_runs',
            '0002_create_game_personal_bests',
            '0003_drop_users_p4_score',
        ],
        recoverable: [],
    });
    assert.equal(connection.calls.some(({ sql }) => /CREATE|INSERT|DROP/.test(sql)), false);
    assert.equal(
        connection.calls.some(({ sql, values }) =>
            sql.includes('lock_wait_timeout') && values[0] === 7
        ),
        true
    );
    assert.equal(
        connection.calls.some(({ sql }) => sql.includes('autocommit = 1')),
        true
    );
    assert.equal(connection.calls.at(-1)?.sql.includes('RELEASE_LOCK'), true);
});

test('plan fails closed when the advisory lock is unavailable', async () => {
    const connection = new FakeConnection((sql) => {
        if (sql.includes('GET_LOCK')) return [{ acquired: 0 }];
        return {};
    });

    await assert.rejects(
        () => planMigrations(connection, loadMigrationManifest(), settings),
        /Could not acquire/
    );
    assert.equal(
        connection.calls.some(({ sql }) => sql.includes('information_schema.TABLES')),
        false
    );
});

test('plan releases the advisory lock when inspection fails', async () => {
    const connection = new FakeConnection((sql) => {
        if (sql.includes('GET_LOCK')) return [{ acquired: 1 }];
        if (sql.includes('RELEASE_LOCK')) return [{ released: 1 }];
        if (sql.includes('information_schema.TABLES')) {
            throw new Error('synthetic metadata failure');
        }
        return {};
    });

    await assert.rejects(
        () => planMigrations(connection, loadMigrationManifest(), settings),
        /synthetic metadata failure/
    );
    assert.equal(connection.calls.at(-1)?.sql.includes('RELEASE_LOCK'), true);
});

test('a failed lock release invalidates the session even after an operation error', async () => {
    const connection = new FakeConnection((sql) => {
        if (sql.includes('GET_LOCK')) return [{ acquired: 1 }];
        if (sql.includes('RELEASE_LOCK')) throw new Error('synthetic release failure');
        if (sql.includes('information_schema.TABLES')) {
            throw new Error('synthetic metadata failure');
        }
        return {};
    });

    await assert.rejects(
        () => planMigrations(connection, loadMigrationManifest(), settings),
        /synthetic metadata failure/
    );
    assert.equal(connection.destroyed, true);
});

test('migration lock name is stable, scoped, and within MySQL limits', () => {
    const name = migrationLockName('migration_test');

    assert.equal(name, migrationLockName('migration_test'));
    assert.notEqual(name, migrationLockName('another_database'));
    assert.match(name, /^mickeyf:leaderboard:[0-9a-f]{24}$/);
    assert.ok(name.length <= 64);
});

test('plan marks an absent unrecorded drop outcome as recoverable', async () => {
    const state = legacySourceState();
    state.p4ScoreColumn = null;
    const connection = new FakeConnection(migrationResults(state));
    const dropMigration = loadMigrationManifest()[2];

    const plan = await planMigrations(connection, [dropMigration], settings);

    assert.deepEqual(plan, {
        applied: [],
        pending: ['0003_drop_users_p4_score'],
        recoverable: ['0003_drop_users_p4_score'],
    });
});

test('plan accepts an applied drop only when the column is absent', async () => {
    const dropMigration = loadMigrationManifest()[2];
    const state = legacySourceState();
    state.historyExists = true;
    state.p4ScoreColumn = null;
    state.appliedRows.push({
        version: dropMigration.version,
        checksum: dropMigration.checksum,
    });
    const connection = new FakeConnection(migrationResults(state));

    const plan = await planMigrations(connection, [dropMigration], settings);

    assert.deepEqual(plan, {
        applied: ['0003_drop_users_p4_score'],
        pending: [],
        recoverable: [],
    });
});

test('plan refuses a p4_score column with unreviewed dependencies', async () => {
    const state = legacySourceState();
    state.p4IndexDependencies = [{ name: 'idx_legacy_p4_score' }];
    const connection = new FakeConnection(migrationResults(state));

    await assert.rejects(
        () => planMigrations(connection, [loadMigrationManifest()[2]], settings),
        /index dependencies/
    );
});

test('drop-column effects remain pending without explicit apply authorization', async () => {
    const connection = new FakeConnection(migrationResults(legacySourceState()));
    const dropMigration = loadMigrationManifest()[2];

    const plan = await applyMigrations(connection, [dropMigration], settings);

    assert.deepEqual(plan, {
        applied: [],
        pending: ['0003_drop_users_p4_score'],
        recoverable: [],
    });
    assert.equal(
        connection.calls.some(({ sql }) =>
            sql.includes('INSERT INTO schema_migrations')
            || sql.trim() === dropMigration.sql.trim()
        ),
        false
    );
});

test('authorized drop rechecks its source and verifies absence before history', async () => {
    const state = legacySourceState();
    const connection = new FakeConnection(migrationResults(state));
    const dropMigration = loadMigrationManifest()[2];

    const plan = await applyMigrations(connection, [dropMigration], settings, {
        allowedEffectKinds: ['drop-column'],
    });

    assert.deepEqual(plan, {
        applied: ['0003_drop_users_p4_score'],
        pending: [],
        recoverable: [],
    });
    const ddlCallIndex = connection.calls.findIndex(
        ({ sql }) => sql.trim() === dropMigration.sql.trim()
    );
    const sourceChecksBeforeDdl = connection.calls
        .slice(0, ddlCallIndex)
        .filter(({ sql }) =>
            sql.includes('information_schema.COLUMNS')
            && sql.includes("COLUMN_NAME = 'p4_score'")
        );
    const postconditionIndex = connection.calls.findIndex(
        ({ sql }, index) =>
            index > ddlCallIndex
            && sql.includes('information_schema.COLUMNS')
            && sql.includes("COLUMN_NAME = 'p4_score'")
    );
    const historyInsertIndex = connection.calls.findIndex(
        ({ sql }) => sql.includes('INSERT INTO schema_migrations')
    );
    assert.ok(sourceChecksBeforeDdl.length >= 3);
    assert.ok(ddlCallIndex >= 0);
    assert.ok(postconditionIndex > ddlCallIndex);
    assert.ok(historyInsertIndex > postconditionIndex);
    assert.equal(state.p4ScoreColumn, null);
});
