import type { LeaderboardTableName } from './migrationManifest';

export interface MigrationConnection {
    query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
    destroy?(): void;
}

type ExpectedColumn = Readonly<{
    name: string;
    type: string;
    nullable: 'YES' | 'NO';
    characterSet: string | null;
    collation: string | null;
    extra: string;
    datetimePrecision: number | null;
    defaultValue: string | null;
    comment: string;
}>;

type ExpectedIndex = Readonly<{
    name: string;
    unique: boolean;
    visible: 'YES';
    type: 'BTREE';
    columns: readonly Readonly<{
        name: string;
        order: 'A' | 'D';
        subPart: null;
    }>[];
}>;

type ExpectedForeignKey = Readonly<{
    name: string;
    columns: readonly string[];
    referencedTable: string;
    referencedColumns: readonly string[];
    updateRule: 'RESTRICT';
    deleteRule: 'RESTRICT';
    sameSchema: true;
}>;

type ExpectedCheck = Readonly<{
    name: string;
    normalizedClause: string;
    enforced: 'YES';
}>;

type ExpectedTable = Readonly<{
    columns: readonly ExpectedColumn[];
    indexes: readonly ExpectedIndex[];
    foreignKeys: readonly ExpectedForeignKey[];
    checks: readonly ExpectedCheck[];
}>;

type TableRow = {
    engine: string;
    tableCollation: string;
};

type ColumnRow = {
    name: string;
    type: string;
    nullable: 'YES' | 'NO';
    characterSet: string | null;
    collation: string | null;
    extra: string;
    datetimePrecision: number | null;
    defaultValue: string | null;
    comment: string;
};

type IndexRow = {
    name: string;
    nonUnique: number;
    sequence: number;
    columnName: string;
    indexOrder: 'A' | 'D' | null;
    subPart: number | null;
    visible: 'YES' | 'NO';
    indexType: string;
};

type ForeignKeyRow = {
    name: string;
    sequence: number;
    columnName: string;
    referencedTable: string;
    referencedColumn: string;
    updateRule: 'RESTRICT';
    deleteRule: 'RESTRICT';
    sameSchema: number;
};

type CheckRow = {
    name: string;
    clause: string;
    enforced: 'YES' | 'NO';
};

const DATETIME_PRECISION = 6;

const HISTORY_TABLE: ExpectedTable = Object.freeze({
    columns: Object.freeze([
        column('version', 'varchar(128)', 'NO', 'ascii', 'ascii_bin'),
        column('checksum', 'binary(32)', 'NO'),
        column(
            'applied_at',
            'datetime(6)',
            'NO',
            null,
            null,
            '',
            DATETIME_PRECISION,
            null,
            'UTC'
        ),
    ]),
    indexes: Object.freeze([
        index('PRIMARY', true, [['version', 'A']]),
    ]),
    foreignKeys: Object.freeze([]),
    checks: Object.freeze([]),
});

const LEADERBOARD_TABLES: Readonly<Record<LeaderboardTableName, ExpectedTable>> =
    Object.freeze({
        game_runs: Object.freeze({
            columns: Object.freeze([
                column('game_run_id', 'bigint unsigned', 'NO', null, null, 'auto_increment'),
                column('game_id', 'varchar(64)', 'NO', 'ascii', 'ascii_bin'),
                column('rules_version', 'int unsigned', 'NO'),
                column('user_id', 'int', 'NO'),
                column('run_id', 'char(36)', 'NO', 'ascii', 'ascii_bin'),
                column('score', 'int', 'NO'),
                column('completion_time_ms', 'int unsigned', 'YES'),
                column('payload_fingerprint', 'binary(32)', 'NO'),
                column('personal_best', 'tinyint unsigned', 'NO'),
                column(
                    'submitted_at',
                    'datetime(6)',
                    'NO',
                    null,
                    null,
                    '',
                    DATETIME_PRECISION,
                    null,
                    'UTC'
                ),
            ]),
            indexes: Object.freeze([
                index('PRIMARY', true, [['game_run_id', 'A']]),
                index('idx_game_runs_user_submitted_at', false, [
                    ['user_id', 'A'],
                    ['submitted_at', 'D'],
                ]),
                index('uq_game_runs_idempotency', true, [
                    ['game_id', 'A'],
                    ['user_id', 'A'],
                    ['run_id', 'A'],
                ]),
                index('uq_game_runs_source_identity', true, [
                    ['game_id', 'A'],
                    ['rules_version', 'A'],
                    ['user_id', 'A'],
                    ['game_run_id', 'A'],
                ]),
            ]),
            foreignKeys: Object.freeze([
                foreignKey(
                    'fk_game_runs_user',
                    ['user_id'],
                    'users',
                    ['user_id']
                ),
            ]),
            checks: Object.freeze([
                check(
                    'chk_game_runs_completion_time_positive',
                    'completion_time_msisnullorcompletion_time_ms>0'
                ),
                check(
                    'chk_game_runs_personal_best_boolean',
                    'personal_bestin0,1'
                ),
                check('chk_game_runs_rules_version', 'rules_version>0'),
            ]),
        }),
        game_personal_bests: Object.freeze({
            columns: Object.freeze([
                column('game_id', 'varchar(64)', 'NO', 'ascii', 'ascii_bin'),
                column('rules_version', 'int unsigned', 'NO'),
                column('user_id', 'int', 'NO'),
                column('score', 'int', 'NO'),
                column('completion_time_ms', 'int unsigned', 'YES'),
                column(
                    'recorded_at',
                    'datetime(6)',
                    'NO',
                    null,
                    null,
                    '',
                    DATETIME_PRECISION,
                    null,
                    'UTC'
                ),
                column('source_game_run_id', 'bigint unsigned', 'YES'),
            ]),
            indexes: Object.freeze([
                index('PRIMARY', true, [
                    ['game_id', 'A'],
                    ['rules_version', 'A'],
                    ['user_id', 'A'],
                ]),
                index('idx_game_personal_bests_completion_leaderboard', false, [
                    ['game_id', 'A'],
                    ['rules_version', 'A'],
                    ['completion_time_ms', 'A'],
                    ['recorded_at', 'A'],
                    ['user_id', 'A'],
                    ['score', 'A'],
                ]),
                index('idx_game_personal_bests_score_leaderboard', false, [
                    ['game_id', 'A'],
                    ['rules_version', 'A'],
                    ['score', 'D'],
                    ['recorded_at', 'A'],
                    ['user_id', 'A'],
                ]),
                index('idx_game_personal_bests_source_game_run', false, [
                    ['game_id', 'A'],
                    ['rules_version', 'A'],
                    ['user_id', 'A'],
                    ['source_game_run_id', 'A'],
                ]),
                index('idx_game_personal_bests_user', false, [['user_id', 'A']]),
            ]),
            foreignKeys: Object.freeze([
                foreignKey(
                    'fk_game_personal_bests_source_game_run',
                    ['game_id', 'rules_version', 'user_id', 'source_game_run_id'],
                    'game_runs',
                    ['game_id', 'rules_version', 'user_id', 'game_run_id']
                ),
                foreignKey(
                    'fk_game_personal_bests_user',
                    ['user_id'],
                    'users',
                    ['user_id']
                ),
            ]),
            checks: Object.freeze([
                check(
                    'chk_game_personal_bests_completion_time_positive',
                    'completion_time_msisnullorcompletion_time_ms>0'
                ),
                check('chk_game_personal_bests_rules_version', 'rules_version>0'),
            ]),
        }),
    });

function column(
    name: string,
    type: string,
    nullable: 'YES' | 'NO',
    characterSet: string | null = null,
    collation: string | null = null,
    extra = '',
    datetimePrecision: number | null = null,
    defaultValue: string | null = null,
    comment = ''
): ExpectedColumn {
    return Object.freeze({
        name,
        type,
        nullable,
        characterSet,
        collation,
        extra,
        datetimePrecision,
        defaultValue,
        comment,
    });
}

function index(
    name: string,
    unique: boolean,
    columns: readonly (readonly [string, 'A' | 'D'])[]
): ExpectedIndex {
    return Object.freeze({
        name,
        unique,
        visible: 'YES',
        type: 'BTREE',
        columns: Object.freeze(columns.map(([columnName, order]) =>
            Object.freeze({ name: columnName, order, subPart: null })
        )),
    });
}

function foreignKey(
    name: string,
    columns: readonly string[],
    referencedTable: string,
    referencedColumns: readonly string[]
): ExpectedForeignKey {
    return Object.freeze({
        name,
        columns: Object.freeze([...columns]),
        referencedTable,
        referencedColumns: Object.freeze([...referencedColumns]),
        updateRule: 'RESTRICT',
        deleteRule: 'RESTRICT',
        sameSchema: true,
    });
}

function check(name: string, normalizedClause: string): ExpectedCheck {
    return Object.freeze({ name, normalizedClause, enforced: 'YES' });
}

function normalizeCheckClause(clause: string): string {
    return clause.toLowerCase().replace(/[`\s()]/g, '');
}

async function queryRows<T>(
    connection: MigrationConnection,
    sql: string,
    values: unknown[] = []
): Promise<T[]> {
    const [rows] = await connection.query(sql, values);
    if (!Array.isArray(rows)) {
        throw new Error('Migration metadata query returned an unexpected result');
    }
    return rows as T[];
}

function assertExact(label: string, actual: unknown, expected: unknown): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
            `${label} does not match the reviewed migration schema; `
            + `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
        );
    }
}

export async function tableExists(
    connection: MigrationConnection,
    tableName: string
): Promise<boolean> {
    const rows = await queryRows<{ tableCount: number }>(connection, `
        SELECT COUNT(*) AS tableCount
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
    `, [tableName]);

    return Number(rows[0]?.tableCount) === 1;
}

export async function verifyHistoryTable(connection: MigrationConnection): Promise<void> {
    await verifyTable(connection, 'schema_migrations', HISTORY_TABLE);
}

export async function verifyLeaderboardTable(
    connection: MigrationConnection,
    tableName: LeaderboardTableName
): Promise<void> {
    await verifyTable(connection, tableName, LEADERBOARD_TABLES[tableName]);
}

async function verifyTable(
    connection: MigrationConnection,
    tableName: string,
    expected: ExpectedTable
): Promise<void> {
    const tableRows = await queryRows<TableRow>(connection, `
        SELECT ENGINE AS engine, TABLE_COLLATION AS tableCollation
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
    `, [tableName]);
    assertExact(`${tableName} table settings`, tableRows, [{
        engine: 'InnoDB',
        tableCollation: 'utf8mb4_unicode_ci',
    }]);

    const columns = await queryRows<ColumnRow>(connection, `
        SELECT
            COLUMN_NAME AS name,
            COLUMN_TYPE AS type,
            IS_NULLABLE AS nullable,
            CHARACTER_SET_NAME AS characterSet,
            COLLATION_NAME AS collation,
            EXTRA AS extra,
            DATETIME_PRECISION AS datetimePrecision,
            COLUMN_DEFAULT AS defaultValue,
            COLUMN_COMMENT AS comment
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
    `, [tableName]);
    assertExact(`${tableName} columns`, columns, expected.columns);

    const indexRows = await queryRows<IndexRow>(connection, `
        SELECT
            INDEX_NAME AS name,
            NON_UNIQUE AS nonUnique,
            SEQ_IN_INDEX AS sequence,
            COLUMN_NAME AS columnName,
            COLLATION AS indexOrder,
            SUB_PART AS subPart,
            IS_VISIBLE AS visible,
            INDEX_TYPE AS indexType
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX
    `, [tableName]);
    const indexes = [...new Set(indexRows.map(({ name }) => name))].map((name) => {
        const rows = indexRows.filter((row) => row.name === name);
        return {
            name,
            unique: Number(rows[0].nonUnique) === 0,
            visible: rows[0].visible,
            type: rows[0].indexType,
            columns: rows.map((row) => ({
                name: row.columnName,
                order: row.indexOrder ?? 'A',
                subPart: row.subPart,
            })),
        };
    });
    const byIndexName = (left: { name: string }, right: { name: string }) =>
        left.name.toLowerCase().localeCompare(right.name.toLowerCase());
    assertExact(
        `${tableName} indexes`,
        indexes.sort(byIndexName),
        [...expected.indexes].sort(byIndexName)
    );

    const foreignKeyRows = await queryRows<ForeignKeyRow>(connection, `
        SELECT
            keyColumns.CONSTRAINT_NAME AS name,
            keyColumns.ORDINAL_POSITION AS sequence,
            keyColumns.COLUMN_NAME AS columnName,
            keyColumns.REFERENCED_TABLE_NAME AS referencedTable,
            keyColumns.REFERENCED_COLUMN_NAME AS referencedColumn,
            referentialRules.UPDATE_RULE AS updateRule,
            referentialRules.DELETE_RULE AS deleteRule,
            keyColumns.REFERENCED_TABLE_SCHEMA = DATABASE() AS sameSchema
        FROM information_schema.KEY_COLUMN_USAGE AS keyColumns
        INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS AS referentialRules
            ON referentialRules.CONSTRAINT_SCHEMA = keyColumns.CONSTRAINT_SCHEMA
           AND referentialRules.TABLE_NAME = keyColumns.TABLE_NAME
           AND referentialRules.CONSTRAINT_NAME = keyColumns.CONSTRAINT_NAME
        WHERE keyColumns.TABLE_SCHEMA = DATABASE()
          AND keyColumns.TABLE_NAME = ?
          AND keyColumns.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY keyColumns.CONSTRAINT_NAME, keyColumns.ORDINAL_POSITION
    `, [tableName]);
    const foreignKeys = [...new Set(foreignKeyRows.map(({ name }) => name))].map((name) => {
        const rows = foreignKeyRows.filter((row) => row.name === name);
        return {
            name,
            columns: rows.map(({ columnName }) => columnName),
            referencedTable: rows[0].referencedTable,
            referencedColumns: rows.map(({ referencedColumn }) => referencedColumn),
            updateRule: rows[0].updateRule,
            deleteRule: rows[0].deleteRule,
            sameSchema: Number(rows[0].sameSchema) === 1,
        };
    });
    assertExact(`${tableName} foreign keys`, foreignKeys, expected.foreignKeys);

    const checks = await queryRows<CheckRow>(connection, `
        SELECT
            tableConstraints.CONSTRAINT_NAME AS name,
            checkConstraints.CHECK_CLAUSE AS clause,
            tableConstraints.ENFORCED AS enforced
        FROM information_schema.TABLE_CONSTRAINTS AS tableConstraints
        INNER JOIN information_schema.CHECK_CONSTRAINTS AS checkConstraints
            ON checkConstraints.CONSTRAINT_SCHEMA = tableConstraints.CONSTRAINT_SCHEMA
           AND checkConstraints.CONSTRAINT_NAME = tableConstraints.CONSTRAINT_NAME
        WHERE tableConstraints.TABLE_SCHEMA = DATABASE()
          AND tableConstraints.TABLE_NAME = ?
          AND tableConstraints.CONSTRAINT_TYPE = 'CHECK'
        ORDER BY tableConstraints.CONSTRAINT_NAME
    `, [tableName]);
    assertExact(
        `${tableName} checks`,
        checks.map(({ name, clause, enforced }) => ({
            name,
            normalizedClause: normalizeCheckClause(clause),
            enforced,
        })),
        expected.checks
    );

    const triggers = await queryRows<{ name: string }>(connection, `
        SELECT TRIGGER_NAME AS name
        FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = DATABASE()
          AND EVENT_OBJECT_TABLE = ?
        ORDER BY TRIGGER_NAME
    `, [tableName]);
    assertExact(`${tableName} triggers`, triggers, []);
}
