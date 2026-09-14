import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as leaderboardSchema from './leaderboardSchema';
import * as identitySchema from './accountIdentitySchema';
import * as providerIdentitySchema from './providerIdentitySchema';
import * as attemptSchema from './providerAttemptSchema';
import * as sessionSchema from './accountSessionSchema';
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
        if (sql.includes("COLUMN_NAME = 'account_uuid'")) return [];

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
            '0004_detach_personal_best_sources',
            '0005_retain_submission_receipts',
            '0006_add_account_identity',
            '0007_backfill_account_identity',
            '0008_finalize_account_identity',
            '0009_create_account_provider_identities',
            '0010_create_provider_auth_attempts',
            '0011_create_account_sessions',
            '0012_add_session_renewal',
            '0013_add_unique_user_names',
            '0014_allow_passwordless_accounts',
            '0015_extend_provider_attempt_actions',
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

test('provider identities remain pending until their own effect is explicitly selected', async () => {
    const connection = new FakeConnection(migrationResults(legacySourceState()));
    const migration = loadMigrationManifest().find(({ effect }) => effect === 'add-provider-identities')!;
    assert.equal(migration.effect, 'add-provider-identities');
    const plan = await applyMigrations(connection, [migration], settings);
    assert.deepEqual(plan.pending, [migration.version]);
    assert.equal(connection.calls.some(({ sql }) => sql === migration.sql), false);
});

test('provider identity DDL and recovery reject missing historical migration records', async () => {
    const migration = loadMigrationManifest().find(({ effect }) => effect === 'add-provider-identities')!;
    const incomplete = new FakeConnection(migrationResults(legacySourceState()));
    await assert.rejects(applyMigrations(incomplete, [migration], settings, {
        allowedEffectKinds: ['add-provider-identities'],
    }), /all earlier migrations/u);
    assert.equal(incomplete.calls.some(({ sql }) => sql === migration.sql), false);
    const original = migrationResults(legacySourceState());
    const recoverable = new FakeConnection((sql, values) => {
        if (sql.includes('COUNT(*)') && sql.includes('information_schema.TABLES')
            && values[0] === migration.tableName) return [{ tableCount: 1 }];
        return original(sql, values);
    });
    await assert.rejects(planMigrations(recoverable, [migration], settings), /all earlier migrations/u);
    assert.equal(recoverable.calls.some(({ sql }) => /CREATE|INSERT|ALTER/u.test(sql)), false);
});

test('a truncated 0008–0009 manifest cannot bypass provider identity prerequisites', async () => {
    const migrations = loadMigrationManifest().slice(7, 9);
    const state = legacySourceState();
    state.historyExists = true;
    state.appliedRows.push({ version: migrations[0].version, checksum: migrations[0].checksum });
    const original = migrationResults(state);
    const connection = new FakeConnection((sql, values) => {
        if (sql.includes("COLUMN_NAME = 'account_uuid'")) return [{
            type: 'char(36)', nullable: 'NO', characterSet: 'ascii', collation: 'ascii_bin',
            defaultValue: 'uuid()', extra: 'DEFAULT_GENERATED', generationExpression: '',
        }];
        if (sql.includes("INDEX_NAME = 'uq_users_account_uuid'")) return [{
            columnName: 'account_uuid', nonUnique: 0, sequence: 1, subPart: null,
            visible: 'YES', indexType: 'BTREE',
        }];
        if (sql.includes('COUNT(*) AS invalidCount')) return [{ invalidCount: 0 }];
        return original(sql, values);
    });
    await assert.rejects(applyMigrations(connection, migrations, settings, {
        allowedEffectKinds: ['add-provider-identities'],
    }), /all earlier migrations/u);
    assert.equal(connection.calls.some(({ sql }) => /CREATE|INSERT|ALTER/u.test(sql)), false);
    assert.deepEqual(state.appliedRows.map(({ version }) => version), ['0008_finalize_account_identity']);
});

test('provider attempts remain pending until their own effect is explicitly selected', async () => {
    const connection = new FakeConnection(migrationResults(legacySourceState()));
    const migration = loadMigrationManifest().find(({ effect }) => effect === 'add-provider-attempts')!;
    const plan = await applyMigrations(connection, [migration], settings);
    assert.deepEqual(plan.pending, [migration.version]);
    assert.equal(connection.calls.some(({ sql }) => sql === migration.sql
        || sql.includes('INSERT INTO schema_migrations')), false);
});

test('provider attempt DDL and recovery reject missing historical migration records', async () => {
    const migration = loadMigrationManifest().find(({ effect }) => effect === 'add-provider-attempts')!;
    const incomplete = new FakeConnection(migrationResults(legacySourceState()));
    await assert.rejects(applyMigrations(incomplete, [migration], settings, {
        allowedEffectKinds: ['add-provider-attempts'],
    }), /Provider attempts require all earlier migrations/u);
    assert.equal(incomplete.calls.some(({ sql }) => sql === migration.sql), false);
    const original = migrationResults(legacySourceState());
    const recoverable = new FakeConnection((sql, values) => {
        if (sql.includes('COUNT(*)') && sql.includes('information_schema.TABLES')
            && values[0] === migration.tableName) return [{ tableCount: 1 }];
        return original(sql, values);
    });
    await assert.rejects(planMigrations(recoverable, [migration], settings), /all earlier migrations/u);
    assert.equal(recoverable.calls.some(({ sql }) => /CREATE|INSERT|ALTER/u.test(sql)), false);
});

test('recorded provider attempts cannot bypass their prerequisites', async () => {
    const migration = loadMigrationManifest().find(({ effect }) => effect === 'add-provider-attempts')!;
    const state = legacySourceState();
    state.historyExists = true;
    state.appliedRows.push({ version: migration.version, checksum: migration.checksum });
    const connection = new FakeConnection(migrationResults(state));
    await assert.rejects(planMigrations(connection, [migration], settings), /all earlier migrations/u);
    assert.equal(connection.calls.some(({ sql }) => /CREATE|INSERT|ALTER/u.test(sql)), false);
});

test('sessions require explicit selection and complete earlier history for DDL, recovery and recorded state', async () => {
    const migration = loadMigrationManifest().find(({ effect }) => effect === 'add-account-sessions')!;
    const skipped = new FakeConnection(migrationResults(legacySourceState()));
    assert.deepEqual((await applyMigrations(skipped, [migration], settings)).pending, [migration.version]);
    assert.equal(skipped.calls.some(({ sql }) => sql === migration.sql), false);
    const incomplete = new FakeConnection(migrationResults(legacySourceState()));
    await assert.rejects(applyMigrations(incomplete, [migration], settings, {
        allowedEffectKinds: ['add-account-sessions'],
    }), /Account sessions require all earlier migrations/u);
    assert.equal(incomplete.calls.some(({ sql }) => sql === migration.sql), false);
    const original = migrationResults(legacySourceState());
    const recoverable = new FakeConnection((sql, values) => {
        if (sql.includes('COUNT(*)') && sql.includes('information_schema.TABLES')
            && values[0] === migration.tableName) return [{ tableCount: 1 }];
        return original(sql, values);
    });
    await assert.rejects(planMigrations(recoverable, [migration], settings), /all earlier migrations/u);
    const state = legacySourceState();
    state.historyExists = true;
    state.appliedRows.push({ version: migration.version, checksum: migration.checksum });
    await assert.rejects(planMigrations(new FakeConnection(migrationResults(state)), [migration], settings),
        /all earlier migrations/u);
});

test('session renewal requires explicit authorization and complete 0011 history, including DDL recovery', async () => {
    const migration = loadMigrationManifest().find(({ effect }) => effect === 'add-session-renewal')!;
    const skipped = new FakeConnection(migrationResults(legacySourceState()));
    assert.deepEqual((await applyMigrations(skipped, [migration], settings)).pending, [migration.version]);
    assert.equal(skipped.calls.some(({ sql }) => sql === migration.sql), false);
    const incomplete = new FakeConnection(migrationResults(legacySourceState()));
    await assert.rejects(applyMigrations(incomplete, [migration], settings, {
        allowedEffectKinds: ['add-session-renewal'],
    }), /Session renewal require all earlier migrations/u);
    assert.equal(incomplete.calls.some(({ sql }) => sql === migration.sql), false);
    const original = migrationResults(legacySourceState());
    const recoverable = new FakeConnection((sql, values) => {
        if (sql.includes('COUNT(*)') && sql.includes('information_schema.TABLES')
            && values[0] === migration.tableName) return [{ tableCount: 1 }];
        if (sql.includes('COLUMN_NAME IN')) return ['remembered', 'renewed_at',
            'previous_session_hash', 'previous_valid_until'].map(name => ({ name }));
        return original(sql, values);
    });
    await assert.rejects(planMigrations(recoverable, [migration], settings), /all earlier migrations/u);
    const state = legacySourceState(); state.historyExists = true;
    state.appliedRows.push({ version: migration.version, checksum: migration.checksum });
    await assert.rejects(planMigrations(new FakeConnection(migrationResults(state)), [migration], settings),
        /all earlier migrations/u);
    assert.equal(recoverable.calls.some(({ sql }) => /CREATE|INSERT|ALTER/u.test(sql)), false);
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

test('passwordless migration effects require explicit selection and complete earlier history', async () => {
    for (const migration of loadMigrationManifest().slice(12)) {
        const skipped = new FakeConnection(migrationResults(legacySourceState()));
        assert.deepEqual((await applyMigrations(skipped, [migration], settings)).pending, [migration.version]);
        assert.equal(skipped.calls.some(({ sql }) => sql === migration.sql), false);
        const incomplete = new FakeConnection(migrationResults(legacySourceState()));
        await assert.rejects(applyMigrations(incomplete, [migration], settings, {
            allowedEffectKinds: [migration.effect],
        }), /all earlier migrations/u);
        assert.equal(incomplete.calls.some(({ sql }) => sql === migration.sql), false);
        const recordedState = legacySourceState(); recordedState.historyExists = true;
        recordedState.appliedRows.push({ version: migration.version, checksum: migration.checksum });
        await assert.rejects(planMigrations(new FakeConnection(migrationResults(recordedState)), [migration], settings),
            /all earlier migrations/u);
    }
});

/** Historical schema validators have separate exact-metadata suites; isolate runner stage coordination here. */
function passwordlessRunnerFixture(t: TestContext, options: {
    recordedCount?: number; unique?: boolean; passwordless?: boolean; extended?: boolean; duplicates?: boolean;
} = {}) {
    const migrations = loadMigrationManifest();
    const state = { unique: options.unique ?? false, passwordless: options.passwordless ?? false,
        extended: options.extended ?? false,
        applied: migrations.slice(0, options.recordedCount ?? 12).map(({ version, checksum }) => ({ version, checksum })) };
    t.mock.method(leaderboardSchema, 'verifyHistoryTable', async () => {});
    t.mock.method(leaderboardSchema, 'verifyLeaderboardStage', async () => {});
    t.mock.method(leaderboardSchema, 'verifyLegacyP4ScoreColumnAbsent', async () => {});
    t.mock.method(leaderboardSchema, 'personalBestSourceExists', async () => false);
    t.mock.method(identitySchema, 'verifyAccountIdentitySchema', async () => {});
    t.mock.method(identitySchema, 'inspectAccountIdentityStage', async () => 'complete');
    t.mock.method(identitySchema, 'accountIdentityBackfillComplete', async () => true);
    t.mock.method(providerIdentitySchema, 'verifyProviderIdentitySchema', async () => {});
    t.mock.method(attemptSchema, 'inspectProviderAttemptStage', async () => state.extended ? 'extended' : 'legacy');
    t.mock.method(attemptSchema, 'verifyProviderAttemptSchema', async (_connection: MigrationConnection,
        stage: attemptSchema.ProviderAttemptSchemaStage = 'legacy') => {
        assert.equal(stage, state.extended ? 'extended' : 'legacy', 'each recorded postcondition must use the current exact attempt stage');
    });
    t.mock.method(sessionSchema, 'verifyAccountSessionSchema', async () => {});
    t.mock.method(sessionSchema, 'verifyRenewableAccountSessionSchema', async () => {});
    t.mock.method(sessionSchema, 'inspectAccountSessionRenewal', async () => true);
    const connection = new FakeConnection((sql, values) => {
        if (sql.includes('GET_LOCK')) return [{ acquired: 1 }];
        if (sql.includes('RELEASE_LOCK')) return [{ released: 1 }];
        if (sql.includes('COUNT(*)') && sql.includes('information_schema.TABLES')) {
            return [{ tableCount: values[0] === 'game_runs' ? 0 : 1 }];
        }
        if (sql.includes('FROM schema_migrations')) return state.applied;
        if (sql.includes('INSERT INTO schema_migrations')) {
            state.applied.push({ version: String(values[0]), checksum: values[1] as Buffer }); return {};
        }
        if (sql.includes('information_schema.TABLES')) return [{ engine: 'InnoDB', tableType: 'BASE TABLE' }];
        if (sql.includes('information_schema.COLUMNS')) return [{ type: 'varchar(255)',
            nullable: values[0] === 'user_password' && state.passwordless ? 'YES' : 'NO',
            characterSet: 'utf8mb4', collation: 'utf8mb4_unicode_ci', defaultValue: null,
            extra: '', comment: '', generationExpression: '' }];
        if (sql.includes('information_schema.STATISTICS')) return state.unique ? [{
            columnName: 'user_name', nonUnique: 0, sequence: 1, indexOrder: 'A', subPart: null,
            visible: 'YES', indexType: 'BTREE',
        }] : [];
        if (sql.includes('GROUP BY user_name')) return options.duplicates ? [{ duplicateFound: 1 }] : [];
        if (sql === migrations[12].sql) { state.unique = true; return {}; }
        if (sql === migrations[13].sql) { state.passwordless = true; return {}; }
        if (sql === migrations[14].sql) { state.extended = true; return {}; }
        if (sql.trim().startsWith('SET SESSION')) return {};
        throw new Error('Unexpected passwordless runner query');
    });
    return { connection, migrations, state };
}

test('passwordless DDL is ordered, verifies each outcome before history, and plans cleanly at 0015', async t => {
    const { connection, migrations } = passwordlessRunnerFixture(t);
    const plan = await applyMigrations(connection, migrations, settings, {
        allowedEffectKinds: ['add-unique-user-names', 'allow-passwordless-accounts', 'extend-provider-attempt-actions'],
    });
    assert.deepEqual(plan.pending, []);
    assert.deepEqual(plan.applied, migrations.map(({ version }) => version));
    assert.deepEqual(connection.calls.filter(({ sql }) => sql.startsWith('ALTER TABLE')).map(({ sql }) => sql),
        migrations.slice(12).map(({ sql }) => sql));
    assert.ok(connection.calls.findIndex(({ sql }) => sql.includes('GROUP BY user_name'))
        < connection.calls.findIndex(({ sql }) => sql === migrations[12].sql));
    for (const migration of migrations.slice(12)) {
        const ddl = connection.calls.findIndex(({ sql }) => sql === migration.sql);
        const history = connection.calls.findIndex(({ sql, values }) => sql.includes('INSERT INTO schema_migrations')
            && values[0] === migration.version);
        assert.ok(history > ddl + 1, 'postcondition metadata must precede the history write');
    }
});

test('duplicate username preflight stops before any new DDL or history', async t => {
    const { connection, migrations, state } = passwordlessRunnerFixture(t, { duplicates: true });
    await assert.rejects(applyMigrations(connection, migrations, settings, {
        allowedEffectKinds: ['add-unique-user-names'],
    }), /duplicate user names require explicit resolution/u);
    assert.equal(state.applied.length, 12);
    assert.equal(connection.calls.some(({ sql }) => /^(?:ALTER TABLE|INSERT INTO schema_migrations)/u.test(sql)), false);
});

test('each completed passwordless DDL can recover missing history without repeating the ALTER', async t => {
    for (const index of [12, 13, 14]) {
        const fixture = passwordlessRunnerFixture(t, { recordedCount: index,
            unique: true, passwordless: index >= 13, extended: index >= 14 });
        const migration = fixture.migrations[index];
        const before = await planMigrations(fixture.connection, fixture.migrations, settings);
        assert.deepEqual(before.recoverable, [migration.version]);
        const after = await applyMigrations(fixture.connection, fixture.migrations, settings, {
            allowedEffectKinds: [migration.effect],
        });
        assert.ok(after.applied.includes(migration.version));
        assert.equal(fixture.connection.calls.some(({ sql }) => sql.startsWith('ALTER TABLE')), false);
        t.mock.restoreAll();
    }
});

test('recorded 0015 rejects legacy checks, while extended checks reject missing prerequisite history', async t => {
    const missingOutcome = passwordlessRunnerFixture(t, { recordedCount: 15, unique: true, passwordless: true });
    await assert.rejects(planMigrations(missingOutcome.connection, missingOutcome.migrations, settings),
        /current exact attempt stage/u);
    t.mock.restoreAll();
    const missingHistory = passwordlessRunnerFixture(t, { recordedCount: 13, unique: true, passwordless: true, extended: true });
    await assert.rejects(planMigrations(missingHistory.connection, missingHistory.migrations, settings), /all earlier migrations/u);
    assert.equal(missingHistory.connection.calls.some(({ sql }) => /^(?:ALTER TABLE|INSERT INTO schema_migrations)/u.test(sql)), false);
});
