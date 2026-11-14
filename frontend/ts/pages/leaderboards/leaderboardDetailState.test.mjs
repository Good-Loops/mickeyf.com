import assert from 'node:assert/strict';
import test from 'node:test';
import { LeaderboardRequestError } from '../../services/leaderboardApi.ts';
import { loadGameLeaderboardState } from './leaderboardDetailState.ts';

const p4VegaGame = {
    gameId: 'p4-vega',
    displayName: 'p4-Vega',
    rulesVersion: 1,
    primaryMetric: 'score',
    sortDirection: 'descending',
    labels: { score: 'Score', completionTime: null, rank: null },
    rankState: 'not-applicable',
    submissionState: 'legacy-only',
};

const threeBossesGame = {
    gameId: 'three-bosses',
    displayName: 'Three Bosses',
    rulesVersion: 1,
    primaryMetric: 'completionTimeMs',
    sortDirection: 'ascending',
    labels: { score: 'Score', completionTime: 'Time', rank: 'Rank' },
    rankState: 'ranked',
    submissionState: 'disabled',
};

const catalog = {
    success: true,
    contractVersion: 1,
    games: [p4VegaGame, threeBossesGame],
};

const p4VegaLeaderboard = {
    success: true,
    contractVersion: 1,
    gameId: 'p4-vega',
    rulesVersion: 1,
    entries: [
        { position: 1, userName: 'Vega Pilot', score: 12_345 },
    ],
};

const threeBossesLeaderboard = {
    success: true,
    contractVersion: 1,
    gameId: 'three-bosses',
    rulesVersion: 1,
    entries: [
        {
            position: 1,
            userName: 'Boss Hunter',
            score: 163_308,
            completionTimeMs: 61_234,
            rank: 'A',
        },
    ],
};

for (const [game, leaderboard] of [
    [p4VegaGame, p4VegaLeaderboard],
    [threeBossesGame, threeBossesLeaderboard],
]) {
    test(`loads ${game.gameId} and forwards the same abort signal to both readers`, async () => {
        const controller = new AbortController();
        const requests = [];

        const result = await loadGameLeaderboardState(game.gameId, controller.signal, {
            readCatalog: async (signal) => {
                assert.equal(signal, controller.signal);
                requests.push(['catalog']);
                return catalog;
            },
            readGame: async (gameId, signal) => {
                assert.equal(signal, controller.signal);
                requests.push(['game', gameId]);
                return leaderboard;
            },
        });

        assert.deepEqual(result, { status: 'success', game, leaderboard });
        assert.deepEqual(requests, [
            ['catalog'],
            ['game', game.gameId],
        ]);
    });
}

for (const gameId of ['not-a-game', undefined, '']) {
    test(`returns recovery games without a game request for route ${JSON.stringify(gameId)}`, async () => {
        let gameReadCount = 0;

        const result = await loadGameLeaderboardState(gameId, undefined, {
            readCatalog: async () => catalog,
            readGame: async () => {
                gameReadCount += 1;
                return p4VegaLeaderboard;
            },
        });

        assert.deepEqual(result, { status: 'not-found', games: catalog.games });
        assert.equal(gameReadCount, 0);
    });
}

test('returns a catalog error without selecting or requesting a game', async () => {
    let gameReadCount = 0;

    const result = await loadGameLeaderboardState('p4-vega', undefined, {
        readCatalog: async () => {
            throw new Error('catalog unavailable');
        },
        readGame: async () => {
            gameReadCount += 1;
            return p4VegaLeaderboard;
        },
    });

    assert.deepEqual(result, {
        status: 'error',
        game: null,
        message: 'catalog unavailable',
    });
    assert.equal(gameReadCount, 0);
});

test('preserves the selected game and message when its leaderboard request fails', async () => {
    const result = await loadGameLeaderboardState('p4-vega', undefined, {
        readCatalog: async () => catalog,
        readGame: async () => {
            throw new Error('service unavailable');
        },
    });

    assert.deepEqual(result, {
        status: 'error',
        game: p4VegaGame,
        message: 'service unavailable',
    });
});

test('rejects a leaderboard whose rules version differs from its catalog entry', async () => {
    const result = await loadGameLeaderboardState('p4-vega', undefined, {
        readCatalog: async () => catalog,
        readGame: async () => ({
            ...p4VegaLeaderboard,
            rulesVersion: p4VegaGame.rulesVersion + 1,
        }),
    });

    assert.deepEqual(result, {
        status: 'error',
        game: p4VegaGame,
        message: 'The leaderboard service returned an unexpected response.',
    });
});

for (const gameId of ['p4-vega', 'three-bosses']) {
    test(`returns recovery games when the API no longer recognizes ${gameId}`, async () => {
        const result = await loadGameLeaderboardState(gameId, undefined, {
            readCatalog: async () => catalog,
            readGame: async () => {
                throw new LeaderboardRequestError(
                    'That leaderboard does not exist.',
                    404,
                    'UNKNOWN_GAME'
                );
            },
        });

        assert.deepEqual(result, { status: 'not-found', games: catalog.games });
    });
}

for (const requestStage of ['catalog', 'game']) {
    test(`propagates ${requestStage} cancellation instead of rendering an error`, async () => {
        const controller = new AbortController();
        const cancellation = new DOMException('Route changed.', 'AbortError');
        let gameReadCount = 0;

        await assert.rejects(
            loadGameLeaderboardState('p4-vega', controller.signal, {
                readCatalog: async (signal) => {
                    if (requestStage === 'catalog') {
                        controller.abort(cancellation);
                        signal.throwIfAborted();
                    }
                    return catalog;
                },
                readGame: async (_gameId, signal) => {
                    gameReadCount += 1;
                    controller.abort(cancellation);
                    signal.throwIfAborted();
                },
            }),
            (error) => error === cancellation
        );
        assert.equal(gameReadCount, requestStage === 'catalog' ? 0 : 1);
    });
}

test('uses the fallback message when a reader rejects with a non-Error value', async () => {
    const result = await loadGameLeaderboardState('p4-vega', undefined, {
        readCatalog: async () => catalog,
        readGame: async () => {
            throw 'unstructured failure';
        },
    });

    assert.deepEqual(result, {
        status: 'error',
        game: p4VegaGame,
        message: 'The leaderboard could not be loaded.',
    });
});
