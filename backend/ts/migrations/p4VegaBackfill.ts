import type { MigrationConfig } from '../config/migrationConfig';
import type { MigrationConnection } from './leaderboardSchema';
import type { MigrationDefinition } from './migrationManifest';
import {
    type MigrationRunnerSettings,
    withVerifiedLeaderboardSchema,
} from './migrationRunner';

const P4_VEGA_GAME_ID = 'p4-vega';
const P4_VEGA_RULES_VERSION = 1;
const MINIMUM_USER_ID_EXCLUSIVE = -2_147_483_649;
const MAX_CHUNK_ATTEMPTS = 3;
const SIGNED_INT_MINIMUM = -2_147_483_648;
const SIGNED_INT_MAXIMUM = 2_147_483_647;
const UTC_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u;

export interface P4VegaBackfillConnection extends MigrationConnection {
    beginTransaction(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    destroy(): void;
}

export type P4VegaOperationSettings = MigrationRunnerSettings & Pick<
    MigrationConfig,
    'p4VegaBackfillChunkSize'
>;

export type P4VegaAggregateSummary = Readonly<{
    rowCount: string;
    minimumScore: number | null;
    maximumScore: number | null;
    scoreSum: string;
}>;

export type P4VegaReconciliationReport = Readonly<{
    legacy: P4VegaAggregateSummary;
    generic: P4VegaAggregateSummary;
    missingCount: string;
    mismatchCount: string;
    genericLowerCount: string;
    genericHigherCount: string;
    matchedCount: string;
    extraCount: string;
    metadataAnomalyCount: string;
    unexpectedGameRunCount: string;
    unexpectedRulesVersionCount: string;
    consistent: boolean;
}>;

export type P4VegaReconciliationRows = Readonly<{
    aggregates: Readonly<{
        legacyCount: unknown;
        legacyMinimum: unknown;
        legacyMaximum: unknown;
        legacySum: unknown;
        genericCount: unknown;
        genericMinimum: unknown;
        genericMaximum: unknown;
        genericSum: unknown;
    }>;
    sourceDifferences: Readonly<{
        missingCount: unknown;
        mismatchCount: unknown;
        genericLowerCount: unknown;
        genericHigherCount: unknown;
        matchedCount: unknown;
    }>;
    targetAnomalies: Readonly<{
        extraCount: unknown;
        metadataAnomalyCount: unknown;
    }>;
    unexpected: Readonly<{
        unexpectedGameRunCount: unknown;
        unexpectedRulesVersionCount: unknown;
    }>;
}>;

export type P4VegaBackfillResult = Readonly<{
    sharedRecordedAt: string;
    chunksProcessed: number;
    reconciliation: P4VegaReconciliationReport;
}>;

type LegacySourceTableRow = {
    engine: unknown;
};

type LegacySourceColumnRow = {
    name: unknown;
    columnType: unknown;
    nullable: unknown;
    extra: unknown;
};

type LegacySourcePrimaryKeyRow = {
    name: unknown;
    nonUnique: unknown;
    sequence: unknown;
};

type AppliedAtRow = {
    appliedAt: unknown;
};

type UserBoundaryRow = {
    userId: unknown;
};

type AggregateRow = P4VegaReconciliationRows['aggregates'];
type SourceDifferenceRow = P4VegaReconciliationRows['sourceDifferences'];
type TargetAnomalyRow = P4VegaReconciliationRows['targetAnomalies'];
type UnexpectedRow = P4VegaReconciliationRows['unexpected'];

export class P4VegaDataRollbackError extends Error {
    constructor(
        readonly operationError: unknown,
        readonly rollbackError: unknown
    ) {
        super('The p4-Vega data operation and its rollback both failed');
        this.name = 'P4VegaDataRollbackError';
    }
}

async function queryRows<T>(
    connection: MigrationConnection,
    sql: string,
    values: unknown[] = []
): Promise<T[]> {
    const [rows] = await connection.query(sql, values);
    if (!Array.isArray(rows)) {
        throw new Error('p4-Vega data query returned an unexpected result');
    }
    return rows as T[];
}

async function querySingleRow<T>(
    connection: MigrationConnection,
    sql: string,
    values: unknown[] = []
): Promise<T> {
    const rows = await queryRows<T>(connection, sql, values);
    if (rows.length !== 1) {
        throw new Error('p4-Vega data query must return exactly one aggregate row');
    }
    return rows[0];
}

function canonicalDecimal(
    value: unknown,
    label: string,
    allowNegative: boolean
): string {
    const raw = typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : value;
    if (typeof raw !== 'string') {
        throw new Error(`${label} returned a non-integer database value`);
    }

    const pattern = allowNegative ? /^-?\d+$/u : /^\d+$/u;
    if (!pattern.test(raw)) {
        throw new Error(`${label} returned a malformed integer database value`);
    }

    const negative = raw.startsWith('-');
    const digits = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/u, '');
    return negative && digits !== '0' ? `-${digits}` : digits;
}

function nonNegativeDecimal(value: unknown, label: string): string {
    return canonicalDecimal(value, label, false);
}

function scoreValue(value: unknown, label: string): number | null {
    if (value === null) return null;

    const canonical = canonicalDecimal(value, label, true);
    const parsed = Number(canonical);
    if (
        !Number.isSafeInteger(parsed)
        || parsed < SIGNED_INT_MINIMUM
        || parsed > SIGNED_INT_MAXIMUM
    ) {
        throw new Error(`${label} is outside the signed INT range`);
    }
    return parsed;
}

function addNonNegativeDecimals(left: string, right: string): string {
    let carry = 0;
    let result = '';
    let leftIndex = left.length - 1;
    let rightIndex = right.length - 1;

    while (leftIndex >= 0 || rightIndex >= 0 || carry > 0) {
        const leftDigit = leftIndex >= 0 ? left.charCodeAt(leftIndex) - 48 : 0;
        const rightDigit = rightIndex >= 0 ? right.charCodeAt(rightIndex) - 48 : 0;
        const sum = leftDigit + rightDigit + carry;
        result = String(sum % 10) + result;
        carry = Math.floor(sum / 10);
        leftIndex -= 1;
        rightIndex -= 1;
    }

    return result;
}

function multiplyNonNegativeDecimalByInteger(
    value: string,
    multiplier: number
): string {
    if (value === '0' || multiplier === 0) return '0';

    let carry = 0;
    let result = '';
    for (let index = value.length - 1; index >= 0; index -= 1) {
        const product = (value.charCodeAt(index) - 48) * multiplier + carry;
        result = String(product % 10) + result;
        carry = Math.floor(product / 10);
    }
    while (carry > 0) {
        result = String(carry % 10) + result;
        carry = Math.floor(carry / 10);
    }
    return result;
}

function multiplyCountByScore(count: string, score: number): string {
    const absoluteProduct = multiplyNonNegativeDecimalByInteger(
        count,
        Math.abs(score)
    );
    return score < 0 && absoluteProduct !== '0' ? `-${absoluteProduct}` : absoluteProduct;
}

function compareCanonicalSignedDecimals(left: string, right: string): number {
    const leftNegative = left.startsWith('-');
    const rightNegative = right.startsWith('-');
    if (leftNegative !== rightNegative) return leftNegative ? -1 : 1;

    const leftAbsolute = leftNegative ? left.slice(1) : left;
    const rightAbsolute = rightNegative ? right.slice(1) : right;
    let absoluteComparison = leftAbsolute.length - rightAbsolute.length;
    if (absoluteComparison === 0) {
        absoluteComparison = leftAbsolute.localeCompare(rightAbsolute);
    }
    return leftNegative ? -absoluteComparison : absoluteComparison;
}

function assertDecimalSum(
    actual: string,
    operands: readonly string[],
    label: string
): void {
    const expected = operands.reduce(addNonNegativeDecimals, '0');
    if (actual !== expected) {
        throw new Error(`${label} reconciliation counts are internally inconsistent`);
    }
}

function buildAggregateSummary(
    rowCountValue: unknown,
    minimumValue: unknown,
    maximumValue: unknown,
    sumValue: unknown,
    label: string
): P4VegaAggregateSummary {
    const rowCount = nonNegativeDecimal(rowCountValue, `${label} count`);
    const minimumScore = scoreValue(minimumValue, `${label} minimum`);
    const maximumScore = scoreValue(maximumValue, `${label} maximum`);
    const scoreSum = canonicalDecimal(sumValue, `${label} sum`, true);

    if (rowCount === '0') {
        if (minimumScore !== null || maximumScore !== null || scoreSum !== '0') {
            throw new Error(`${label} empty aggregate returned contradictory values`);
        }
    } else {
        if (minimumScore === null || maximumScore === null) {
            throw new Error(`${label} non-empty aggregate omitted its score bounds`);
        }
        if (minimumScore > maximumScore) {
            throw new Error(`${label} aggregate score bounds are reversed`);
        }
        const minimumPossibleSum = multiplyCountByScore(rowCount, minimumScore);
        const maximumPossibleSum = multiplyCountByScore(rowCount, maximumScore);
        if (
            compareCanonicalSignedDecimals(scoreSum, minimumPossibleSum) < 0
            || compareCanonicalSignedDecimals(scoreSum, maximumPossibleSum) > 0
        ) {
            throw new Error(`${label} aggregate sum is outside its possible score bounds`);
        }
    }

    return Object.freeze({ rowCount, minimumScore, maximumScore, scoreSum });
}

export function buildP4VegaReconciliationReport(
    rows: P4VegaReconciliationRows
): P4VegaReconciliationReport {
    const legacy = buildAggregateSummary(
        rows.aggregates.legacyCount,
        rows.aggregates.legacyMinimum,
        rows.aggregates.legacyMaximum,
        rows.aggregates.legacySum,
        'Legacy p4-Vega'
    );
    const generic = buildAggregateSummary(
        rows.aggregates.genericCount,
        rows.aggregates.genericMinimum,
        rows.aggregates.genericMaximum,
        rows.aggregates.genericSum,
        'Generic p4-Vega'
    );
    const missingCount = nonNegativeDecimal(
        rows.sourceDifferences.missingCount,
        'Missing-row count'
    );
    const mismatchCount = nonNegativeDecimal(
        rows.sourceDifferences.mismatchCount,
        'Score-mismatch count'
    );
    const genericLowerCount = nonNegativeDecimal(
        rows.sourceDifferences.genericLowerCount,
        'Generic-lower count'
    );
    const genericHigherCount = nonNegativeDecimal(
        rows.sourceDifferences.genericHigherCount,
        'Generic-higher count'
    );
    const matchedCount = nonNegativeDecimal(
        rows.sourceDifferences.matchedCount,
        'Matched-row count'
    );
    const extraCount = nonNegativeDecimal(
        rows.targetAnomalies.extraCount,
        'Extra-row count'
    );
    const metadataAnomalyCount = nonNegativeDecimal(
        rows.targetAnomalies.metadataAnomalyCount,
        'Metadata-anomaly count'
    );
    const unexpectedGameRunCount = nonNegativeDecimal(
        rows.unexpected.unexpectedGameRunCount,
        'Unexpected game-run count'
    );
    const unexpectedRulesVersionCount = nonNegativeDecimal(
        rows.unexpected.unexpectedRulesVersionCount,
        'Unexpected rules-version count'
    );

    assertDecimalSum(mismatchCount, [genericLowerCount, genericHigherCount], 'Source');
    assertDecimalSum(
        legacy.rowCount,
        [missingCount, matchedCount, mismatchCount],
        'Legacy'
    );
    assertDecimalSum(
        generic.rowCount,
        [extraCount, matchedCount, mismatchCount],
        'Generic'
    );

    const discrepancyCounts = [
        missingCount,
        mismatchCount,
        genericLowerCount,
        genericHigherCount,
        extraCount,
        metadataAnomalyCount,
        unexpectedGameRunCount,
        unexpectedRulesVersionCount,
    ];
    const aggregatesMatch = legacy.rowCount === generic.rowCount
        && legacy.minimumScore === generic.minimumScore
        && legacy.maximumScore === generic.maximumScore
        && legacy.scoreSum === generic.scoreSum;

    return Object.freeze({
        legacy,
        generic,
        missingCount,
        mismatchCount,
        genericLowerCount,
        genericHigherCount,
        matchedCount,
        extraCount,
        metadataAnomalyCount,
        unexpectedGameRunCount,
        unexpectedRulesVersionCount,
        consistent: aggregatesMatch && discrepancyCounts.every((count) => count === '0'),
    });
}

export function assertP4VegaBackfillPreflightSafe(
    report: P4VegaReconciliationReport
): void {
    const unsafeConditions = [
        ['generic-higher rows', report.genericHigherCount],
        ['extra generic rows', report.extraCount],
        ['unexpected personal-best metadata', report.metadataAnomalyCount],
        ['unexpected p4-Vega game runs', report.unexpectedGameRunCount],
        ['unexpected p4-Vega rules versions', report.unexpectedRulesVersionCount],
    ].filter(([, count]) => count !== '0');

    if (unsafeConditions.length > 0) {
        throw new Error(
            `p4-Vega backfill preflight refused: ${unsafeConditions
                .map(([label]) => label)
                .join(', ')}`
        );
    }

    if (
        report.missingCount === '0'
        && report.genericLowerCount === '0'
        && !report.consistent
    ) {
        throw new Error('p4-Vega backfill preflight found unexplained aggregate drift');
    }
}

async function verifyLegacyP4SourceSchema(
    connection: MigrationConnection
): Promise<void> {
    const tableRows = await queryRows<LegacySourceTableRow>(connection, `
        SELECT ENGINE AS engine
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'users'
    `);
    if (tableRows.length !== 1 || tableRows[0].engine !== 'InnoDB') {
        throw new Error('Legacy p4-Vega source must be the reviewed InnoDB users table');
    }

    const columnRows = await queryRows<LegacySourceColumnRow>(connection, `
        SELECT
            COLUMN_NAME AS name,
            COLUMN_TYPE AS columnType,
            IS_NULLABLE AS nullable,
            EXTRA AS extra
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'users'
          AND COLUMN_NAME IN ('user_id', 'p4_score')
        ORDER BY ORDINAL_POSITION
    `);
    const expectedColumns = [
        { name: 'user_id', columnType: 'int', nullable: 'NO', extra: 'auto_increment' },
        { name: 'p4_score', columnType: 'int', nullable: 'YES', extra: '' },
    ];
    if (JSON.stringify(columnRows) !== JSON.stringify(expectedColumns)) {
        throw new Error('Legacy p4-Vega source columns do not match the reviewed schema');
    }

    const primaryKeyRows = await queryRows<LegacySourcePrimaryKeyRow>(connection, `
        SELECT
            COLUMN_NAME AS name,
            NON_UNIQUE AS nonUnique,
            SEQ_IN_INDEX AS sequence
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'users'
          AND INDEX_NAME = 'PRIMARY'
        ORDER BY SEQ_IN_INDEX
    `);
    const expectedPrimaryKey = [{ name: 'user_id', nonUnique: 0, sequence: 1 }];
    if (JSON.stringify(primaryKeyRows) !== JSON.stringify(expectedPrimaryKey)) {
        throw new Error('Legacy p4-Vega source requires user_id as its exact primary key');
    }
}

async function readSharedRecordedAt(
    connection: MigrationConnection,
    migrations: readonly MigrationDefinition[]
): Promise<string> {
    const personalBestMigration = migrations.find(
        ({ tableName }) => tableName === 'game_personal_bests'
    );
    if (!personalBestMigration) {
        throw new Error('Migration manifest omits game_personal_bests');
    }

    const row = await querySingleRow<AppliedAtRow>(connection, `
        SELECT DATE_FORMAT(applied_at, '%Y-%m-%d %H:%i:%s.%f') AS appliedAt
        FROM schema_migrations
        WHERE version = ?
    `, [personalBestMigration.version]);
    if (typeof row.appliedAt !== 'string' || !UTC_DATETIME.test(row.appliedAt)) {
        throw new Error('Personal-best migration history has an invalid UTC timestamp');
    }
    return row.appliedAt;
}

async function configureBackfillSession(
    connection: MigrationConnection,
    lockWaitTimeoutSeconds: number
): Promise<void> {
    await connection.query("SET SESSION time_zone = '+00:00'");
    await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await connection.query(
        'SET SESSION innodb_lock_wait_timeout = ?',
        [lockWaitTimeoutSeconds]
    );
}

async function readUserBoundary(
    connection: MigrationConnection,
    lowerExclusive: number,
    highWaterMark: number,
    chunkSize: number
): Promise<number | null> {
    const row = await querySingleRow<UserBoundaryRow>(connection, `
        SELECT MAX(chunk.user_id) AS userId
        FROM (
            SELECT user_id
            FROM users
            WHERE user_id > ?
              AND user_id <= ?
            ORDER BY user_id
            LIMIT ?
        ) AS chunk
    `, [lowerExclusive, highWaterMark, chunkSize]);
    return scoreValue(row.userId, 'p4-Vega user chunk boundary');
}

function isRetryableLockFailure(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { code?: unknown; errno?: unknown };
    return candidate.code === 'ER_LOCK_DEADLOCK'
        || candidate.code === 'ER_LOCK_WAIT_TIMEOUT'
        || candidate.errno === 1_213
        || candidate.errno === 1_205;
}

async function waitBeforeLockRetry(attempt: number): Promise<void> {
    const exponentialDelayMs = 25 * (2 ** (attempt - 1));
    const jitterMs = Math.floor(Math.random() * 25);
    await new Promise<void>((resolve) => {
        setTimeout(resolve, exponentialDelayMs + jitterMs);
    });
}

async function rollbackAfterFailure(
    connection: P4VegaBackfillConnection,
    operationError: unknown
): Promise<void> {
    try {
        await connection.rollback();
    } catch (rollbackError) {
        connection.destroy();
        throw new P4VegaDataRollbackError(operationError, rollbackError);
    }
}

async function backfillChunk(
    connection: P4VegaBackfillConnection,
    lowerExclusive: number,
    upperInclusive: number,
    sharedRecordedAt: string
): Promise<void> {
    for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt += 1) {
        let transactionStarted = false;
        try {
            await connection.beginTransaction();
            transactionStarted = true;
            await connection.query(`
                INSERT INTO game_personal_bests (
                    game_id,
                    rules_version,
                    user_id,
                    score,
                    completion_time_ms,
                    recorded_at,
                    source_game_run_id
                )
                SELECT
                    incoming_game_id,
                    incoming_rules_version,
                    incoming_user_id,
                    incoming_score,
                    incoming_completion_time_ms,
                    incoming_recorded_at,
                    incoming_source_game_run_id
                FROM (
                    SELECT
                        ? AS incoming_game_id,
                        ? AS incoming_rules_version,
                        users.user_id AS incoming_user_id,
                        users.p4_score AS incoming_score,
                        NULL AS incoming_completion_time_ms,
                        CAST(? AS DATETIME(6)) AS incoming_recorded_at,
                        NULL AS incoming_source_game_run_id
                    FROM users
                    WHERE users.user_id > ?
                      AND users.user_id <= ?
                      AND users.p4_score IS NOT NULL
                ) AS incoming
                ORDER BY incoming_user_id
                ON DUPLICATE KEY UPDATE
                    -- MySQL evaluates assignments left-to-right. Compare against
                    -- the old score before the following assignment changes it.
                    recorded_at = IF(
                        incoming_score > game_personal_bests.score,
                        incoming_recorded_at,
                        game_personal_bests.recorded_at
                    ),
                    score = GREATEST(
                        game_personal_bests.score,
                        incoming_score
                    )
            `, [
                P4_VEGA_GAME_ID,
                P4_VEGA_RULES_VERSION,
                sharedRecordedAt,
                lowerExclusive,
                upperInclusive,
            ]);
            await connection.commit();
            return;
        } catch (error) {
            if (transactionStarted) await rollbackAfterFailure(connection, error);
            if (!isRetryableLockFailure(error) || attempt === MAX_CHUNK_ATTEMPTS) {
                throw error;
            }
            await waitBeforeLockRetry(attempt);
        }
    }
}

async function reconcileWithinVerifiedSchema(
    connection: P4VegaBackfillConnection
): Promise<P4VegaReconciliationReport> {
    await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    let transactionStarted = false;
    try {
        await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        transactionStarted = true;

        const aggregates = await querySingleRow<AggregateRow>(connection, `
            SELECT
                legacy.row_count AS legacyCount,
                legacy.minimum_score AS legacyMinimum,
                legacy.maximum_score AS legacyMaximum,
                legacy.score_sum AS legacySum,
                generic.row_count AS genericCount,
                generic.minimum_score AS genericMinimum,
                generic.maximum_score AS genericMaximum,
                generic.score_sum AS genericSum
            FROM (
                SELECT
                    COUNT(*) AS row_count,
                    MIN(p4_score) AS minimum_score,
                    MAX(p4_score) AS maximum_score,
                    COALESCE(SUM(CAST(p4_score AS DECIMAL(65, 0))), 0) AS score_sum
                FROM users
                WHERE p4_score IS NOT NULL
            ) AS legacy
            CROSS JOIN (
                SELECT
                    COUNT(*) AS row_count,
                    MIN(score) AS minimum_score,
                    MAX(score) AS maximum_score,
                    COALESCE(SUM(CAST(score AS DECIMAL(65, 0))), 0) AS score_sum
                FROM game_personal_bests
                WHERE game_id = ?
                  AND rules_version = ?
            ) AS generic
        `, [P4_VEGA_GAME_ID, P4_VEGA_RULES_VERSION]);

        const sourceDifferences = await querySingleRow<SourceDifferenceRow>(connection, `
            SELECT
                COALESCE(SUM(best.user_id IS NULL), 0) AS missingCount,
                COALESCE(SUM(
                    best.user_id IS NOT NULL
                    AND NOT (best.score <=> users.p4_score)
                ), 0) AS mismatchCount,
                COALESCE(SUM(
                    best.user_id IS NOT NULL
                    AND best.score < users.p4_score
                ), 0) AS genericLowerCount,
                COALESCE(SUM(
                    best.user_id IS NOT NULL
                    AND best.score > users.p4_score
                ), 0) AS genericHigherCount,
                COALESCE(SUM(
                    best.user_id IS NOT NULL
                    AND (best.score <=> users.p4_score)
                ), 0) AS matchedCount
            FROM users
            LEFT JOIN game_personal_bests AS best
              ON best.game_id = ?
             AND best.rules_version = ?
             AND best.user_id = users.user_id
            WHERE users.p4_score IS NOT NULL
        `, [P4_VEGA_GAME_ID, P4_VEGA_RULES_VERSION]);

        const targetAnomalies = await querySingleRow<TargetAnomalyRow>(connection, `
            SELECT
                COALESCE(SUM(
                    users.user_id IS NULL OR users.p4_score IS NULL
                ), 0) AS extraCount,
                COALESCE(SUM(
                    best.completion_time_ms IS NOT NULL
                    OR best.source_game_run_id IS NOT NULL
                ), 0) AS metadataAnomalyCount
            FROM game_personal_bests AS best
            LEFT JOIN users
              ON users.user_id = best.user_id
            WHERE best.game_id = ?
              AND best.rules_version = ?
        `, [P4_VEGA_GAME_ID, P4_VEGA_RULES_VERSION]);

        const unexpected = await querySingleRow<UnexpectedRow>(connection, `
            SELECT
                (
                    SELECT COUNT(*)
                    FROM game_runs
                    WHERE game_id = ?
                ) AS unexpectedGameRunCount,
                (
                    SELECT COUNT(*)
                    FROM game_personal_bests
                    WHERE game_id = ?
                      AND rules_version <> ?
                ) AS unexpectedRulesVersionCount
        `, [P4_VEGA_GAME_ID, P4_VEGA_GAME_ID, P4_VEGA_RULES_VERSION]);

        await connection.commit();
        transactionStarted = false;
        return buildP4VegaReconciliationReport({
            aggregates,
            sourceDifferences,
            targetAnomalies,
            unexpected,
        });
    } catch (error) {
        if (transactionStarted) await rollbackAfterFailure(connection, error);
        throw error;
    }
}

export async function reconcileP4VegaScores(
    connection: P4VegaBackfillConnection,
    migrations: readonly MigrationDefinition[],
    settings: P4VegaOperationSettings
): Promise<P4VegaReconciliationReport> {
    return withVerifiedLeaderboardSchema(connection, migrations, settings, async () => {
        await verifyLegacyP4SourceSchema(connection);
        return reconcileWithinVerifiedSchema(connection);
    });
}

export async function backfillP4VegaScores(
    connection: P4VegaBackfillConnection,
    migrations: readonly MigrationDefinition[],
    settings: P4VegaOperationSettings
): Promise<P4VegaBackfillResult> {
    return withVerifiedLeaderboardSchema(connection, migrations, settings, async () => {
        await verifyLegacyP4SourceSchema(connection);
        const sharedRecordedAt = await readSharedRecordedAt(connection, migrations);
        const initialReport = await reconcileWithinVerifiedSchema(connection);
        assertP4VegaBackfillPreflightSafe(initialReport);
        await configureBackfillSession(connection, settings.lockWaitTimeoutSeconds);

        const highWaterRow = await querySingleRow<UserBoundaryRow>(connection, `
            SELECT MAX(user_id) AS userId
            FROM users
        `);
        const highWaterMark = scoreValue(
            highWaterRow.userId,
            'p4-Vega user high-water mark'
        );
        let chunksProcessed = 0;
        let lowerExclusive = MINIMUM_USER_ID_EXCLUSIVE;

        while (highWaterMark !== null && lowerExclusive < highWaterMark) {
            const upperInclusive = await readUserBoundary(
                connection,
                lowerExclusive,
                highWaterMark,
                settings.p4VegaBackfillChunkSize
            );
            if (upperInclusive === null) break;

            await backfillChunk(
                connection,
                lowerExclusive,
                upperInclusive,
                sharedRecordedAt
            );
            lowerExclusive = upperInclusive;
            chunksProcessed += 1;
        }

        const reconciliation = await reconcileWithinVerifiedSchema(connection);
        return Object.freeze({ sharedRecordedAt, chunksProcessed, reconciliation });
    });
}
