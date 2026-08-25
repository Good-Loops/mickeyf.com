import assert from 'node:assert/strict';
import test from 'node:test';
import {
    assertP4VegaBackfillPreflightSafe,
    buildP4VegaReconciliationReport,
    type P4VegaReconciliationRows,
} from './p4VegaBackfill';

function cleanRows(): P4VegaReconciliationRows {
    return {
        aggregates: {
            legacyCount: 2,
            legacyMinimum: 0,
            legacyMaximum: 990,
            legacySum: '990',
            genericCount: 2,
            genericMinimum: 0,
            genericMaximum: 990,
            genericSum: '990',
        },
        sourceDifferences: {
            missingCount: 0,
            mismatchCount: 0,
            genericLowerCount: 0,
            genericHigherCount: 0,
            matchedCount: 2,
        },
        targetAnomalies: {
            extraCount: 0,
            metadataAnomalyCount: 0,
        },
        unexpected: {
            unexpectedGameRunCount: 0,
            unexpectedRulesVersionCount: 0,
        },
    };
}

function withAggregates(
    rows: P4VegaReconciliationRows,
    overrides: Partial<P4VegaReconciliationRows['aggregates']>
): P4VegaReconciliationRows {
    return {
        ...rows,
        aggregates: { ...rows.aggregates, ...overrides },
    };
}

function withSourceDifferences(
    rows: P4VegaReconciliationRows,
    overrides: Partial<P4VegaReconciliationRows['sourceDifferences']>
): P4VegaReconciliationRows {
    return {
        ...rows,
        sourceDifferences: { ...rows.sourceDifferences, ...overrides },
    };
}

function withTargetAnomalies(
    rows: P4VegaReconciliationRows,
    overrides: Partial<P4VegaReconciliationRows['targetAnomalies']>
): P4VegaReconciliationRows {
    return {
        ...rows,
        targetAnomalies: { ...rows.targetAnomalies, ...overrides },
    };
}

function withUnexpected(
    rows: P4VegaReconciliationRows,
    overrides: Partial<P4VegaReconciliationRows['unexpected']>
): P4VegaReconciliationRows {
    return {
        ...rows,
        unexpected: { ...rows.unexpected, ...overrides },
    };
}

test('normalizes an exactly reconciled report and permits the backfill preflight', () => {
    const report = buildP4VegaReconciliationReport(cleanRows());

    assert.deepEqual(report, {
        legacy: {
            rowCount: '2',
            minimumScore: 0,
            maximumScore: 990,
            scoreSum: '990',
        },
        generic: {
            rowCount: '2',
            minimumScore: 0,
            maximumScore: 990,
            scoreSum: '990',
        },
        missingCount: '0',
        mismatchCount: '0',
        genericLowerCount: '0',
        genericHigherCount: '0',
        matchedCount: '2',
        extraCount: '0',
        metadataAnomalyCount: '0',
        unexpectedGameRunCount: '0',
        unexpectedRulesVersionCount: '0',
        consistent: true,
    });
    assert.doesNotThrow(() => assertP4VegaBackfillPreflightSafe(report));
});

test('preserves decimal sums beyond the JavaScript safe-integer boundary', () => {
    const rowCount = 50_000_000;
    const score = 2_147_483_647;
    const scoreSum = '107374182350000000';
    const rows = withSourceDifferences(
        withAggregates(cleanRows(), {
            legacyCount: rowCount,
            legacyMinimum: score,
            legacyMaximum: score,
            legacySum: scoreSum,
            genericCount: rowCount,
            genericMinimum: score,
            genericMaximum: score,
            genericSum: scoreSum,
        }),
        { matchedCount: rowCount }
    );

    const report = buildP4VegaReconciliationReport(rows);

    assert.equal(report.legacy.rowCount, String(rowCount));
    assert.equal(report.generic.rowCount, String(rowCount));
    assert.equal(report.legacy.scoreSum, scoreSum);
    assert.equal(report.generic.scoreSum, scoreSum);
    assert.equal(report.matchedCount, String(rowCount));
    assert.equal(report.consistent, true);
    assert.doesNotThrow(() => assertP4VegaBackfillPreflightSafe(report));
});

test('allows source-ahead missing and lower rows that a monotonic backfill can fix', () => {
    const rows: P4VegaReconciliationRows = {
        aggregates: {
            legacyCount: 2,
            legacyMinimum: 400,
            legacyMaximum: 500,
            legacySum: '900',
            genericCount: 1,
            genericMinimum: 400,
            genericMaximum: 400,
            genericSum: '400',
        },
        sourceDifferences: {
            missingCount: 1,
            mismatchCount: 1,
            genericLowerCount: 1,
            genericHigherCount: 0,
            matchedCount: 0,
        },
        targetAnomalies: {
            extraCount: 0,
            metadataAnomalyCount: 0,
        },
        unexpected: {
            unexpectedGameRunCount: 0,
            unexpectedRulesVersionCount: 0,
        },
    };

    const report = buildP4VegaReconciliationReport(rows);

    assert.equal(report.consistent, false);
    assert.equal(report.missingCount, '1');
    assert.equal(report.mismatchCount, '1');
    assert.equal(report.genericLowerCount, '1');
    assert.equal(report.genericHigherCount, '0');
    assert.doesNotThrow(() => assertP4VegaBackfillPreflightSafe(report));
});

test('rejects target-ahead scores that a monotonic source backfill cannot repair', () => {
    const rows = withSourceDifferences(
        withAggregates(cleanRows(), {
            legacyCount: 1,
            legacyMinimum: 500,
            legacyMaximum: 500,
            legacySum: '500',
            genericCount: 1,
            genericMinimum: 600,
            genericMaximum: 600,
            genericSum: '600',
        }),
        {
            mismatchCount: 1,
            genericHigherCount: 1,
            matchedCount: 0,
        }
    );

    const report = buildP4VegaReconciliationReport(rows);

    assert.equal(report.consistent, false);
    assert.equal(report.genericHigherCount, '1');
    assert.throws(() => assertP4VegaBackfillPreflightSafe(report), Error);
});

test('rejects extra, metadata-anomalous, unexpected-rule, and run-ledger states', () => {
    const extraRows: P4VegaReconciliationRows = {
        aggregates: {
            legacyCount: 0,
            legacyMinimum: null,
            legacyMaximum: null,
            legacySum: '0',
            genericCount: 1,
            genericMinimum: 700,
            genericMaximum: 700,
            genericSum: '700',
        },
        sourceDifferences: {
            missingCount: 0,
            mismatchCount: 0,
            genericLowerCount: 0,
            genericHigherCount: 0,
            matchedCount: 0,
        },
        targetAnomalies: {
            extraCount: 1,
            metadataAnomalyCount: 0,
        },
        unexpected: {
            unexpectedGameRunCount: 0,
            unexpectedRulesVersionCount: 0,
        },
    };
    const metadataRows = withTargetAnomalies(cleanRows(), { metadataAnomalyCount: 1 });
    const unexpectedRulesRows = withUnexpected(cleanRows(), {
        unexpectedRulesVersionCount: 1,
    });
    const unexpectedRunsRows = withUnexpected(cleanRows(), {
        unexpectedGameRunCount: 1,
    });

    for (const [name, rows] of [
        ['extra target row', extraRows],
        ['metadata anomaly', metadataRows],
        ['unexpected rules version', unexpectedRulesRows],
        ['unexpected game run', unexpectedRunsRows],
    ] as const) {
        const report = buildP4VegaReconciliationReport(rows);
        assert.equal(report.consistent, false, name);
        assert.throws(
            () => assertP4VegaBackfillPreflightSafe(report),
            Error,
            name
        );
    }
});

test('rejects mismatch totals not explained by lower and higher directions', () => {
    const rows = withSourceDifferences(
        withAggregates(cleanRows(), {
            legacyCount: 1,
            legacyMinimum: 500,
            legacyMaximum: 500,
            legacySum: '500',
            genericCount: 1,
            genericMinimum: 400,
            genericMaximum: 400,
            genericSum: '400',
        }),
        {
            mismatchCount: 1,
            genericLowerCount: 0,
            genericHigherCount: 0,
            matchedCount: 0,
        }
    );

    assert.throws(() => buildP4VegaReconciliationReport(rows), Error);
});

test('rejects malformed numeric database values and impossible aggregate shapes', () => {
    const malformedCases: ReadonlyArray<readonly [string, P4VegaReconciliationRows]> = [
        ['negative count', withAggregates(cleanRows(), { legacyCount: -1 })],
        [
            'fractional count',
            withSourceDifferences(cleanRows(), { missingCount: '1.5' }),
        ],
        [
            'exponent count',
            withSourceDifferences(cleanRows(), { genericHigherCount: '1e2' }),
        ],
        [
            'whitespace-padded count',
            withTargetAnomalies(cleanRows(), { metadataAnomalyCount: ' 0' }),
        ],
        [
            'NaN count',
            withUnexpected(cleanRows(), { unexpectedGameRunCount: Number.NaN }),
        ],
        [
            'infinite count',
            withUnexpected(cleanRows(), {
                unexpectedRulesVersionCount: Number.POSITIVE_INFINITY,
            }),
        ],
        [
            'unsafe numeric count',
            withAggregates(cleanRows(), {
                genericCount: Number.MAX_SAFE_INTEGER + 1,
            }),
        ],
        [
            'fractional minimum score',
            withAggregates(cleanRows(), { legacyMinimum: 0.5 }),
        ],
        [
            'score outside the signed INT range',
            withAggregates(cleanRows(), { genericMaximum: 2_147_483_648 }),
        ],
        [
            'non-decimal sum',
            withAggregates(cleanRows(), { legacySum: 'not-a-number' }),
        ],
        [
            'fractional sum',
            withAggregates(cleanRows(), { genericSum: '990.0' }),
        ],
        [
            'empty aggregate with a minimum',
            withAggregates(cleanRows(), {
                legacyCount: 0,
                legacyMinimum: 0,
                legacyMaximum: null,
                legacySum: '0',
            }),
        ],
        [
            'populated aggregate without a minimum',
            withAggregates(cleanRows(), { legacyMinimum: null }),
        ],
        [
            'minimum greater than maximum',
            withAggregates(cleanRows(), {
                genericMinimum: 990,
                genericMaximum: 0,
            }),
        ],
        [
            'sum outside possible aggregate bounds',
            withAggregates(cleanRows(), {
                legacyCount: 1,
                legacyMinimum: 0,
                legacyMaximum: 0,
                legacySum: '999',
            }),
        ],
    ];

    for (const [name, rows] of malformedCases) {
        assert.throws(
            () => buildP4VegaReconciliationReport(rows),
            Error,
            name
        );
    }
});
