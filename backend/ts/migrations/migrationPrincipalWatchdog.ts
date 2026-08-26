import mysql from 'mysql2';
import {
    getMigrationPrincipalProfile,
    MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT,
    MIGRATION_PRINCIPAL_HOST,
    MIGRATION_PRINCIPAL_REVIEWED_TABLES,
    quoteMigrationPrincipalDatabaseName,
    type MigrationPrincipalProfileName,
} from './migrationPrincipalProfiles';

export interface MigrationPrincipalWatchdogConnection {
    query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
}

type WatchdogServerRow = Readonly<{
    eventScheduler: string;
    currentUser: string;
}>;

type WatchdogAccountRow = Readonly<{
    accountCount: number | string;
}>;

type WatchdogDefinerObjectCountRow = Readonly<{
    bootstrapDefinerObjectCount: number | string;
}>;

type WatchdogMetadataRow = Readonly<{
    eventSchema: string;
    eventName: string;
    definer: string;
    timeZone: string;
    eventBody: string;
    eventDefinition: string;
    sqlMode: string;
    eventType: string;
    executeAt: Date | string | null;
    status: string;
    onCompletion: string;
    eventComment: string;
    lastExecuted: Date | string | null;
    secondsUntilExecution: number | string | null;
}>;

export type MigrationPrincipalWatchdogState = Readonly<{
    profileName: MigrationPrincipalProfileName;
    eventName: string;
    status: 'ENABLED' | 'DISABLED';
    attempted: boolean;
    secondsUntilExecution: number;
    executeAtUtc: string;
}>;

export const MIGRATION_PRINCIPAL_WATCHDOG_MIN_DELAY_SECONDS = 120;
export const MIGRATION_PRINCIPAL_WATCHDOG_MAX_DELAY_SECONDS = 1_800;
export const MIGRATION_PRINCIPAL_WATCHDOG_MIN_CREATE_WINDOW_SECONDS = 60;
export const MIGRATION_PRINCIPAL_WATCHDOG_SQL_MODE =
    'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
export const MIGRATION_PRINCIPAL_WATCHDOG_DEFINERS = Object.freeze([
    'root@%',
    'cms_mickeyf@%',
] as const);
export type MigrationPrincipalWatchdogDefiner =
    typeof MIGRATION_PRINCIPAL_WATCHDOG_DEFINERS[number];

const WATCHDOG_VERSION = 1;
export const MIGRATION_PRINCIPAL_BOOTSTRAP_ROLE = 'cloudsqlsuperuser';

const WATCHDOG_EVENT_NAMES: Readonly<Record<
    MigrationPrincipalProfileName,
    string
>> = Object.freeze({
    'schema-apply': 'mickeyf_watchdog_schema_apply',
    'p4-backfill': 'mickeyf_watchdog_p4_backfill',
    'p4-reconcile': 'mickeyf_watchdog_p4_reconcile',
    'empty-rollback': 'mickeyf_watchdog_empty_rollback',
});

function watchdogComment(profileName: MigrationPrincipalProfileName): string {
    return `mickeyf migration watchdog v${WATCHDOG_VERSION} ${profileName}`;
}

export function getMigrationPrincipalWatchdogEventName(
    profileName: MigrationPrincipalProfileName
): string {
    return WATCHDOG_EVENT_NAMES[profileName];
}

export function assertMigrationPrincipalWatchdogDelay(delaySeconds: number): void {
    if (
        !Number.isSafeInteger(delaySeconds)
        || delaySeconds < MIGRATION_PRINCIPAL_WATCHDOG_MIN_DELAY_SECONDS
        || delaySeconds > MIGRATION_PRINCIPAL_WATCHDOG_MAX_DELAY_SECONDS
    ) {
        throw new Error(
            'Migration-principal watchdog delay must be an integer from '
                + `${MIGRATION_PRINCIPAL_WATCHDOG_MIN_DELAY_SECONDS} through `
                + `${MIGRATION_PRINCIPAL_WATCHDOG_MAX_DELAY_SECONDS} seconds`
        );
    }
}

function normalizeSql(sql: string): string {
    return sql.trim().replace(/\s+/gu, ' ');
}

function accountSql(profileName: MigrationPrincipalProfileName): string {
    const accountName = getMigrationPrincipalProfile(profileName).accountName;
    return `${mysql.escape(accountName)}@${mysql.escape(MIGRATION_PRINCIPAL_HOST)}`;
}

export function assertMigrationPrincipalWatchdogDefiner(
    definer: string
): asserts definer is MigrationPrincipalWatchdogDefiner {
    if (!(MIGRATION_PRINCIPAL_WATCHDOG_DEFINERS as readonly string[]).includes(definer)) {
        throw new Error('Migration-watchdog definer is not in the reviewed allowlist');
    }
}

function definerSql(definer: string): string {
    assertMigrationPrincipalWatchdogDefiner(definer);
    const match = /^([^@]+)@([^@]+)$/u.exec(definer);
    if (!match) throw new Error('Reviewed migration-watchdog definer is invalid');
    return `${mysql.escape(match[1])}@${mysql.escape(match[2])}`;
}

export function buildMigrationPrincipalWatchdogBody(
    database: string,
    profileName: MigrationPrincipalProfileName
): string {
    // Validate the operator-selected database before embedding it as a fixed
    // string literal. All other values come from compile-time allowlists.
    quoteMigrationPrincipalDatabaseName(database);
    const account = accountSql(profileName);
    const bootstrapAccount = `${mysql.escape(MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT)}`
        + `@${mysql.escape(MIGRATION_PRINCIPAL_HOST)}`;
    const bootstrapRole = `${mysql.escape(MIGRATION_PRINCIPAL_BOOTSTRAP_ROLE)}`
        + `@${mysql.escape(MIGRATION_PRINCIPAL_HOST)}`;
    const reviewedTables = MIGRATION_PRINCIPAL_REVIEWED_TABLES
        .map((tableName) => mysql.escape(tableName))
        .join(', ');
    const signalMessage = mysql.escape(
        `Migration watchdog found unexpected ${profileName} triggers`
    );

    return `
        BEGIN
            DECLARE bootstrapAccountCount BIGINT UNSIGNED DEFAULT 0;
            DECLARE bootstrapDefinerObjectCount BIGINT UNSIGNED DEFAULT 0;
            DECLARE operationAccountCount BIGINT UNSIGNED DEFAULT 0;
            DECLARE unexpectedTriggerCount BIGINT UNSIGNED DEFAULT 0;

            SELECT COUNT(*) INTO bootstrapAccountCount
            FROM mysql.user
            WHERE User = ${mysql.escape(MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT)}
              AND Host = ${mysql.escape(MIGRATION_PRINCIPAL_HOST)};

            SELECT COUNT(*) INTO operationAccountCount
            FROM mysql.user
            WHERE User = ${mysql.escape(getMigrationPrincipalProfile(profileName).accountName)}
              AND Host = ${mysql.escape(MIGRATION_PRINCIPAL_HOST)};

            IF bootstrapAccountCount = 1 THEN
                ALTER USER ${bootstrapAccount} ACCOUNT LOCK;
            END IF;
            IF operationAccountCount = 1 THEN
                ALTER USER ${account} ACCOUNT LOCK;
            END IF;

            IF bootstrapAccountCount = 1 THEN
                REVOKE IF EXISTS ${bootstrapRole}
                FROM ${bootstrapAccount} IGNORE UNKNOWN USER;
                REVOKE IF EXISTS ALL PRIVILEGES, GRANT OPTION
                FROM ${bootstrapAccount} IGNORE UNKNOWN USER;
            END IF;

            IF operationAccountCount = 1 THEN
                REVOKE IF EXISTS ALL PRIVILEGES, GRANT OPTION
                FROM ${account} IGNORE UNKNOWN USER;
            END IF;

            SELECT
                (SELECT COUNT(*) FROM information_schema.EVENTS
                 WHERE DEFINER = ${mysql.escape(`${MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT}@${MIGRATION_PRINCIPAL_HOST}`)})
              + (SELECT COUNT(*) FROM information_schema.ROUTINES
                 WHERE DEFINER = ${mysql.escape(`${MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT}@${MIGRATION_PRINCIPAL_HOST}`)})
              + (SELECT COUNT(*) FROM information_schema.TRIGGERS
                 WHERE DEFINER = ${mysql.escape(`${MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT}@${MIGRATION_PRINCIPAL_HOST}`)})
              + (SELECT COUNT(*) FROM information_schema.VIEWS
                 WHERE DEFINER = ${mysql.escape(`${MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT}@${MIGRATION_PRINCIPAL_HOST}`)})
            INTO bootstrapDefinerObjectCount;

            SELECT COUNT(*) INTO unexpectedTriggerCount
            FROM information_schema.TRIGGERS
            WHERE TRIGGER_SCHEMA = ${mysql.escape(database)}
              AND EVENT_OBJECT_TABLE IN (${reviewedTables});

            IF bootstrapDefinerObjectCount = 0 THEN
                DROP USER IF EXISTS ${bootstrapAccount};
            END IF;

            IF bootstrapDefinerObjectCount > 0 THEN
                SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Migration watchdog found bootstrap definer objects';
            ELSEIF unexpectedTriggerCount = 0 THEN
                DROP USER IF EXISTS ${account};
            ELSE
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = ${signalMessage};
            END IF;
        END
    `.trim();
}

function buildCreateEventStatement(
    database: string,
    profileName: MigrationPrincipalProfileName,
    delaySeconds: number,
    definer: string
): string {
    assertMigrationPrincipalWatchdogDelay(delaySeconds);
    const eventName = getMigrationPrincipalWatchdogEventName(profileName);
    const qualifiedEventName = `${quoteMigrationPrincipalDatabaseName(database)}.`
        + mysql.escapeId(eventName, true);
    return `
        CREATE DEFINER = ${definerSql(definer)}
        EVENT ${qualifiedEventName}
        ON SCHEDULE AT CURRENT_TIMESTAMP(6) + INTERVAL ${delaySeconds} SECOND
        ON COMPLETION PRESERVE
        ENABLE
        COMMENT ${mysql.escape(watchdogComment(profileName))}
        DO ${buildMigrationPrincipalWatchdogBody(database, profileName)}
    `.trim();
}

async function assertServerIdentity(
    connection: MigrationPrincipalWatchdogConnection,
    requireScheduler: boolean,
    expectedCurrentUser?: string
): Promise<void> {
    const [result] = await connection.query(`
        SELECT
            @@GLOBAL.event_scheduler AS eventScheduler,
            CURRENT_USER() AS currentUser
    `);
    if (!Array.isArray(result) || result.length !== 1) {
        throw new Error('Could not verify migration-watchdog server identity');
    }
    const { eventScheduler, currentUser } = result[0] as WatchdogServerRow;
    if (
        typeof currentUser !== 'string'
        || !/^[^@\r\n]+@[^@\r\n]+$/u.test(currentUser)
    ) {
        throw new Error('Migration-watchdog database definer was invalid');
    }
    if (requireScheduler && eventScheduler !== 'ON') {
        throw new Error('MySQL Event Scheduler must be ON before arming the watchdog');
    }
    if (expectedCurrentUser !== undefined && currentUser !== expectedCurrentUser) {
        throw new Error('Migration-watchdog connection resolved to an unexpected account');
    }
}

async function configureWatchdogCreationSession(
    connection: MigrationPrincipalWatchdogConnection
): Promise<void> {
    await connection.query("SET SESSION time_zone = '+00:00'");
    await connection.query(
        'SET SESSION sql_mode = ?',
        [MIGRATION_PRINCIPAL_WATCHDOG_SQL_MODE]
    );
}

async function accountCount(
    connection: MigrationPrincipalWatchdogConnection,
    accountName: string
): Promise<number> {
    const [result] = await connection.query(`
        SELECT COUNT(*) AS accountCount
        FROM mysql.user
        WHERE User = ? AND Host = ?
    `, [accountName, MIGRATION_PRINCIPAL_HOST]);
    if (!Array.isArray(result) || result.length !== 1) {
        throw new Error('Could not verify the temporary migration account is absent');
    }
    const accountCount = Number((result[0] as WatchdogAccountRow).accountCount);
    if (!Number.isSafeInteger(accountCount) || accountCount < 0) {
        throw new Error('Temporary migration-account count was invalid');
    }
    return accountCount;
}

async function assertPrincipalAbsent(
    connection: MigrationPrincipalWatchdogConnection,
    profileName: MigrationPrincipalProfileName
): Promise<void> {
    const profileAccountName = getMigrationPrincipalProfile(profileName).accountName;
    if (await accountCount(connection, profileAccountName) !== 0) {
        throw new Error('Migration watchdog must be armed before the temporary account exists');
    }
}

async function assertAllWatchedAccountsAbsent(
    connection: MigrationPrincipalWatchdogConnection,
    profileName: MigrationPrincipalProfileName
): Promise<void> {
    await assertPrincipalAbsent(connection, profileName);
    if (await accountCount(connection, MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT) !== 0) {
        throw new Error('Migration watchdog must be armed before the bootstrap account exists');
    }
}

async function assertFixedDefinerExists(
    connection: MigrationPrincipalWatchdogConnection,
    definer: string
): Promise<void> {
    assertMigrationPrincipalWatchdogDefiner(definer);
    const [accountName, host] = definer.split('@');
    const count = await accountCount(connection, accountName);
    if (host !== MIGRATION_PRINCIPAL_HOST || count !== 1) {
        throw new Error('The fixed migration-watchdog definer must exist exactly once');
    }
}

async function assertNoBootstrapDefinerObjects(
    connection: MigrationPrincipalWatchdogConnection
): Promise<void> {
    const bootstrapDefiner = `${MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT}`
        + `@${MIGRATION_PRINCIPAL_HOST}`;
    const [result] = await connection.query(`
        SELECT
            (SELECT COUNT(*) FROM information_schema.EVENTS WHERE DEFINER = ?)
          + (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE DEFINER = ?)
          + (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE DEFINER = ?)
          + (SELECT COUNT(*) FROM information_schema.VIEWS WHERE DEFINER = ?)
            AS bootstrapDefinerObjectCount
    `, [bootstrapDefiner, bootstrapDefiner, bootstrapDefiner, bootstrapDefiner]);
    if (!Array.isArray(result) || result.length !== 1) {
        throw new Error('Could not verify bootstrap definer-object inventory');
    }
    const count = Number(
        (result[0] as WatchdogDefinerObjectCountRow).bootstrapDefinerObjectCount
    );
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error('Bootstrap definer-object count was invalid');
    }
    if (count !== 0) {
        throw new Error(
            `Watchdog disarm refused ${count} bootstrap definer object(s)`
        );
    }
}

async function readWatchdogMetadata(
    connection: MigrationPrincipalWatchdogConnection,
    database: string,
    profileName: MigrationPrincipalProfileName
): Promise<WatchdogMetadataRow | undefined> {
    const eventName = getMigrationPrincipalWatchdogEventName(profileName);
    const [result] = await connection.query(`
        SELECT
            EVENT_SCHEMA AS eventSchema,
            EVENT_NAME AS eventName,
            DEFINER AS definer,
            TIME_ZONE AS timeZone,
            EVENT_BODY AS eventBody,
            EVENT_DEFINITION AS eventDefinition,
            SQL_MODE AS sqlMode,
            EVENT_TYPE AS eventType,
            EXECUTE_AT AS executeAt,
            STATUS AS status,
            ON_COMPLETION AS onCompletion,
            EVENT_COMMENT AS eventComment,
            LAST_EXECUTED AS lastExecuted,
            TIMESTAMPDIFF(
                SECOND,
                CURRENT_TIMESTAMP(6),
                EXECUTE_AT
            ) AS secondsUntilExecution
        FROM information_schema.EVENTS
        WHERE EVENT_SCHEMA = ? AND EVENT_NAME = ?
    `, [database, eventName]);
    if (!Array.isArray(result) || result.length > 1) {
        throw new Error('Migration-watchdog metadata was invalid');
    }
    return result.length === 0
        ? undefined
        : result[0] as WatchdogMetadataRow;
}

function integer(value: number | string | null, label: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`Migration-watchdog ${label} was invalid`);
    }
    return parsed;
}

function utcTimestamp(value: Date | string | null): string {
    if (
        typeof value === 'string'
        && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/u.test(value)
    ) {
        return `${value.replace(' ', 'T')}Z`;
    }
    if (value instanceof Date && Number.isFinite(value.getTime())) {
        return value.toISOString();
    }
    throw new Error('Migration-watchdog UTC execution timestamp was invalid');
}

function assertOwnedWatchdogMetadata(
    metadata: WatchdogMetadataRow,
    database: string,
    profileName: MigrationPrincipalProfileName,
    expectedDefiner: string
): MigrationPrincipalWatchdogState {
    const eventName = getMigrationPrincipalWatchdogEventName(profileName);
    const expectedBody = buildMigrationPrincipalWatchdogBody(database, profileName);
    if (
        metadata.eventSchema !== database
        || metadata.eventName !== eventName
        || metadata.definer !== expectedDefiner
        || metadata.eventBody !== 'SQL'
        || metadata.sqlMode !== MIGRATION_PRINCIPAL_WATCHDOG_SQL_MODE
        || metadata.eventType !== 'ONE TIME'
        || metadata.executeAt === null
        || (metadata.status !== 'ENABLED' && metadata.status !== 'DISABLED')
        || metadata.onCompletion !== 'PRESERVE'
        || metadata.eventComment !== watchdogComment(profileName)
        || metadata.timeZone !== '+00:00'
        || normalizeSql(metadata.eventDefinition) !== normalizeSql(expectedBody)
    ) {
        throw new Error('Migration-watchdog metadata does not match the reviewed definition');
    }

    return Object.freeze({
        profileName,
        eventName,
        status: metadata.status,
        attempted: metadata.lastExecuted !== null,
        secondsUntilExecution: integer(
            metadata.secondsUntilExecution,
            'execution deadline'
        ),
        executeAtUtc: utcTimestamp(metadata.executeAt),
    });
}

async function dropCreatedWatchdogAfterFailedVerification(
    connection: MigrationPrincipalWatchdogConnection,
    database: string,
    profileName: MigrationPrincipalProfileName
): Promise<void> {
    const qualifiedEventName = `${quoteMigrationPrincipalDatabaseName(database)}.`
        + mysql.escapeId(getMigrationPrincipalWatchdogEventName(profileName), true);
    await connection.query(`DROP EVENT ${qualifiedEventName}`);
    if (await readWatchdogMetadata(connection, database, profileName)) {
        throw new Error('Unverified migration watchdog could not be removed');
    }
}

export async function armMigrationPrincipalWatchdog(
    connection: MigrationPrincipalWatchdogConnection,
    database: string,
    profileName: MigrationPrincipalProfileName,
    delaySeconds: number,
    definer: string
): Promise<MigrationPrincipalWatchdogState> {
    assertMigrationPrincipalWatchdogDelay(delaySeconds);
    assertMigrationPrincipalWatchdogDefiner(definer);
    await assertServerIdentity(connection, true);
    await assertAllWatchedAccountsAbsent(connection, profileName);
    await assertFixedDefinerExists(connection, definer);
    if (await readWatchdogMetadata(connection, database, profileName)) {
        throw new Error('Migration-watchdog event already exists; inspect or disarm it first');
    }

    await configureWatchdogCreationSession(connection);

    await connection.query(
        buildCreateEventStatement(database, profileName, delaySeconds, definer)
    );
    try {
        const metadata = await readWatchdogMetadata(connection, database, profileName);
        if (!metadata) {
            throw new Error('Migration-watchdog event was not visible after creation');
        }
        const state = assertOwnedWatchdogMetadata(
            metadata,
            database,
            profileName,
            definer
        );
        if (
            state.status !== 'ENABLED'
            || state.attempted
            || state.secondsUntilExecution < MIGRATION_PRINCIPAL_WATCHDOG_MIN_CREATE_WINDOW_SECONDS
            || state.secondsUntilExecution > delaySeconds
        ) {
            throw new Error('Migration-watchdog deadline is not safe for account creation');
        }
        return state;
    } catch (verificationError) {
        try {
            await dropCreatedWatchdogAfterFailedVerification(
                connection,
                database,
                profileName
            );
        } catch {
            throw new Error(
                'Migration watchdog failed verification and automatic disarm was not confirmed'
            );
        }
        throw verificationError;
    }
}

export async function assertMigrationPrincipalWatchdogReady(
    connection: MigrationPrincipalWatchdogConnection,
    database: string,
    profileName: MigrationPrincipalProfileName,
    definer: string
): Promise<MigrationPrincipalWatchdogState> {
    assertMigrationPrincipalWatchdogDefiner(definer);
    await assertServerIdentity(connection, true);
    await assertPrincipalAbsent(connection, profileName);
    const metadata = await readWatchdogMetadata(connection, database, profileName);
    if (!metadata) {
        throw new Error('Temporary migration account requires an armed watchdog');
    }
    const state = assertOwnedWatchdogMetadata(
        metadata,
        database,
        profileName,
        definer
    );
    if (
        state.status !== 'ENABLED'
        || state.attempted
        || state.secondsUntilExecution < MIGRATION_PRINCIPAL_WATCHDOG_MIN_CREATE_WINDOW_SECONDS
        || state.secondsUntilExecution > MIGRATION_PRINCIPAL_WATCHDOG_MAX_DELAY_SECONDS
    ) {
        throw new Error('Migration-watchdog deadline is not safe for account creation');
    }
    return state;
}

export async function assertMigrationPrincipalWatchdogStillReady(
    connection: MigrationPrincipalWatchdogConnection,
    database: string,
    profileName: MigrationPrincipalProfileName,
    definer: string
): Promise<MigrationPrincipalWatchdogState> {
    assertMigrationPrincipalWatchdogDefiner(definer);
    await assertServerIdentity(connection, true);
    const metadata = await readWatchdogMetadata(connection, database, profileName);
    if (!metadata) {
        throw new Error('Temporary migration account requires an armed watchdog');
    }
    const state = assertOwnedWatchdogMetadata(
        metadata,
        database,
        profileName,
        definer
    );
    if (
        state.status !== 'ENABLED'
        || state.attempted
        || state.secondsUntilExecution < MIGRATION_PRINCIPAL_WATCHDOG_MIN_CREATE_WINDOW_SECONDS
        || state.secondsUntilExecution > MIGRATION_PRINCIPAL_WATCHDOG_MAX_DELAY_SECONDS
    ) {
        throw new Error('Migration-watchdog deadline is not safe for account creation');
    }
    return state;
}

export async function disarmMigrationPrincipalWatchdog(
    connection: MigrationPrincipalWatchdogConnection,
    database: string,
    profileName: MigrationPrincipalProfileName,
    definer: string
): Promise<void> {
    assertMigrationPrincipalWatchdogDefiner(definer);
    await assertServerIdentity(
        connection,
        false,
        `${MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT}@${MIGRATION_PRINCIPAL_HOST}`
    );
    await assertNoBootstrapDefinerObjects(connection);
    await connection.query(
        'ALTER USER ?@? ACCOUNT LOCK',
        [MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT, MIGRATION_PRINCIPAL_HOST]
    );
    const metadata = await readWatchdogMetadata(connection, database, profileName);
    if (!metadata) {
        throw new Error('Migration-watchdog event is missing; disarm cannot be confirmed');
    }
    assertOwnedWatchdogMetadata(metadata, database, profileName, definer);

    const qualifiedEventName = `${quoteMigrationPrincipalDatabaseName(database)}.`
        + mysql.escapeId(getMigrationPrincipalWatchdogEventName(profileName), true);
    await connection.query(`DROP EVENT ${qualifiedEventName}`);
    if (await readWatchdogMetadata(connection, database, profileName)) {
        throw new Error('Migration-watchdog event removal could not be confirmed');
    }
    // This must remain the final statement: if the process dies after event
    // removal but before here, the bootstrap account is already locked. The
    // caller closes the existing session and verifies absence externally.
    await connection.query(
        'DROP USER ?@?',
        [MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT, MIGRATION_PRINCIPAL_HOST]
    );
}
