import assert from 'node:assert/strict';
import test from 'node:test';
import {
    isValidP4VegaScore,
    P4_VEGA_MAX_SCORE,
} from './p4VegaScorePolicy';

test('accepts the complete boundary of legitimate p4-Vega scores', () => {
    assert.equal(isValidP4VegaScore(0), true);
    assert.equal(isValidP4VegaScore(10), true);
    assert.equal(isValidP4VegaScore(P4_VEGA_MAX_SCORE), true);
});

test('rejects values that current gameplay cannot produce', () => {
    for (const value of [-10, 1, 11, 991, 1000, 1.5, NaN, Infinity, '10', null]) {
        assert.equal(isValidP4VegaScore(value), false, `unexpected valid score: ${String(value)}`);
    }
});
