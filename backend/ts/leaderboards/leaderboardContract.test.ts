import assert from 'node:assert/strict';
import test from 'node:test';
import {
    calculateThreeBossesScore,
    isCanonicalV4RunId,
    isValidThreeBossesCompletionTimeMs,
    LEADERBOARD_CONTRACT_VERSION,
    LEADERBOARD_PAGE_SIZE,
    THREE_BOSSES_MAX_COMPLETION_TIME_MS,
    THREE_BOSSES_MIN_COMPLETION_TIME_MS,
    THREE_BOSSES_RULES_VERSION,
} from './leaderboardContract';
import { getGameDefinition } from './gameCatalog';

test('freezes the version-one contract and bounded leaderboard size', () => {
    assert.equal(LEADERBOARD_CONTRACT_VERSION, 1);
    assert.equal(THREE_BOSSES_RULES_VERSION, 1);
    assert.equal(LEADERBOARD_PAGE_SIZE, 10);
    assert.equal(
        getGameDefinition('three-bosses').rulesVersion,
        THREE_BOSSES_RULES_VERSION
    );
});

test('accepts only canonical lowercase version-four run identifiers', () => {
    assert.equal(isCanonicalV4RunId('550e8400-e29b-41d4-a716-446655440000'), true);

    for (const value of [
        '550E8400-E29B-41D4-A716-446655440000',
        '550e8400-e29b-11d4-a716-446655440000',
        '550e8400e29b41d4a716446655440000',
        '',
        null,
    ]) {
        assert.equal(isCanonicalV4RunId(value), false, `unexpected run id: ${String(value)}`);
    }
});

test('bounds Three Bosses completion time to safe integer milliseconds', () => {
    assert.equal(isValidThreeBossesCompletionTimeMs(THREE_BOSSES_MIN_COMPLETION_TIME_MS), true);
    assert.equal(isValidThreeBossesCompletionTimeMs(THREE_BOSSES_MAX_COMPLETION_TIME_MS), true);

    for (const value of [
        0,
        -1,
        1.5,
        THREE_BOSSES_MAX_COMPLETION_TIME_MS + 1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        '1000',
    ]) {
        assert.equal(
            isValidThreeBossesCompletionTimeMs(value),
            false,
            `unexpected completion time: ${String(value)}`
        );
    }
});

test('derives deterministic Three Bosses scores from canonical milliseconds', () => {
    const vectors = [
        [1, 100_000_000],
        [1_000, 100_000],
        [60_000, 1_667],
        [40_000_000, 3],
        [THREE_BOSSES_MAX_COMPLETION_TIME_MS, 1],
    ] as const;

    for (const [completionTimeMs, expectedScore] of vectors) {
        assert.equal(calculateThreeBossesScore(completionTimeMs), expectedScore);
    }

    assert.throws(() => calculateThreeBossesScore(0), RangeError);
});
