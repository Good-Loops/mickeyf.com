import type { MigrationConnection } from './leaderboardSchema';
import type { MigrationDefinition } from './migrationManifest';
import {
    type MigrationRunnerSettings,
    withVerifiedLeaderboardSchema,
} from './migrationRunner';

const P4_VEGA_GAME_ID = 'p4-vega';
const P4_VEGA_RULES_VERSION = 1;
const SIGNED_INT_MINIMUM = -2_147_483_648;
const SIGNED_INT_MAXIMUM = 2_147_483_647;

export interface P4VegaReconciliationConnection extends MigrationConnection {
    commit(): Promise<void>;
    rollback(): Promise<void>;
    destroy(): void;
}

type P4VegaReconciliationSettings = MigrationRunnerSettings;

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

type AggregateRow = P4VegaReconciliationRows['aggregates'];
type SourceDifferenceRow = P4VegaReconciliationRows['sourceDifferences'];
type TargetAnomalyRow = P4VegaReconciliationRows['targetAnomalies'];
type UnexpectedRow = P4VegaReconciliationRows['unexpected'];

class P4VegaReconciliationRollbackError extends Error {
    constructor(
        readonly operationError: unknown,
        readonly rollbackError: unknown
    ) {
        super('The p4-Vega reconciliation and its rollback both failed');
        this.name = 'P4VegaReconciliationRollbackError';
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

async function rollbackAfterFailure(
    connection: P4VegaReconciliationConnection,
    operationError: unknown
): Promise<void> {
    try {
        await connection.rollback();
    } catch (rollbackError) {
        connection.destroy();
        throw new P4VegaReconciliationRollbackError(operationError, rollbackError);
    }
}

async function reconcileWithinVerifiedSchema(
    connection: P4VegaReconciliationConnection
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
    connection: P4VegaReconciliationConnection,
    migrations: readonly MigrationDefinition[],
    settings: P4VegaReconciliationSettings
): Promise<P4VegaReconciliationReport> {
    return withVerifiedLeaderboardSchema(connection, migrations, settings, async () => {
        await verifyLegacyP4SourceSchema(connection);
        return reconcileWithinVerifiedSchema(connection);
    });
}
