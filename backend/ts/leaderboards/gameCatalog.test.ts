import assert from 'node:assert/strict';
import test from 'node:test';
import {
    GAME_DEFINITIONS,
    GAME_IDS,
    getGameDefinition,
    isGameId,
} from './gameCatalog';

test('uses the proposed stable game identifiers in display order', () => {
    assert.deepEqual(GAME_IDS, ['p4-vega', 'three-bosses']);
    assert.equal(isGameId('p4-vega'), true);
    assert.equal(isGameId('three-bosses'), true);

    for (const value of ['P4-Vega', 'three_bosses', '', 1, null, undefined]) {
        assert.equal(isGameId(value), false, `unexpected game id: ${String(value)}`);
    }
});

test('keeps p4-Vega on its legacy score-descending contract', () => {
    assert.deepEqual(getGameDefinition('p4-vega'), {
        gameId: 'p4-vega',
        displayName: 'p4-Vega',
        rulesVersion: 1,
        primaryMetric: 'score',
        sortDirection: 'descending',
        scoreLabel: 'Score',
        completionTimeLabel: null,
        rankLabel: null,
        rankState: 'not-applicable',
        submissionState: 'legacy-only',
    });
});

test('publishes Three Bosses ranks while keeping submission disabled', () => {
    assert.deepEqual(getGameDefinition('three-bosses'), {
        gameId: 'three-bosses',
        displayName: 'Three Bosses',
        rulesVersion: 1,
        primaryMetric: 'completionTimeMs',
        sortDirection: 'ascending',
        scoreLabel: 'Score',
        completionTimeLabel: 'Time',
        rankLabel: 'Rank',
        rankState: 'ranked',
        submissionState: 'disabled',
    });
});

test('catalog definitions cannot be mutated at runtime', () => {
    assert.equal(Object.isFrozen(GAME_IDS), true);
    assert.equal(Object.isFrozen(GAME_DEFINITIONS), true);
    for (const gameId of GAME_IDS) {
        assert.equal(Object.isFrozen(GAME_DEFINITIONS[gameId]), true);
    }
});
