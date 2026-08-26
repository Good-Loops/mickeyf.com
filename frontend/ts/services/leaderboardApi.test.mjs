import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createLeaderboardApi,
    LeaderboardRequestError,
} from './leaderboardApi.ts';

const catalog = {
    success: true,
    contractVersion: 1,
    games: [
        {
            gameId: 'p4-vega',
            displayName: 'p4-Vega',
            rulesVersion: 1,
            primaryMetric: 'score',
            sortDirection: 'descending',
            labels: { score: 'Score', completionTime: null, rank: null },
            rankState: 'not-applicable',
            submissionState: 'legacy-only',
        },
        {
            gameId: 'three-bosses',
            displayName: 'Three Bosses',
            rulesVersion: 1,
            primaryMetric: 'completionTimeMs',
            sortDirection: 'ascending',
            labels: { score: 'Score', completionTime: 'Time', rank: 'Rank' },
            rankState: 'unranked',
            submissionState: 'disabled',
        },
    ],
};

test('catalog read uses the generic GET endpoint and validates its contract', async () => {
    let observedUrl;
    let observedInit;
    const api = createLeaderboardApi('https://api.example.test/', async (url, init) => {
        observedUrl = url;
        observedInit = init;
        return Response.json(catalog);
    });

    assert.deepEqual(await api.getCatalog(), catalog);
    assert.equal(observedUrl, 'https://api.example.test/api/leaderboards');
    assert.equal(observedInit.method, 'GET');
    assert.equal(observedInit.credentials, 'include');
    assert.equal(observedInit.headers.Accept, 'application/json');
    assert.equal(observedInit.body, undefined);
});

test('game read encodes its route parameter and preserves server order', async () => {
    let observedUrl;
    const response = {
        success: true,
        contractVersion: 1,
        gameId: 'p4-vega',
        rulesVersion: 1,
        entries: [
            { position: 1, userName: 'Same name', score: 1200 },
            { position: 2, userName: 'Same name', score: 900 },
        ],
    };
    const api = createLeaderboardApi('', async (url) => {
        observedUrl = url;
        return Response.json(response);
    });

    assert.deepEqual(await api.getGame('p4-vega'), response);
    assert.equal(observedUrl, '/api/leaderboards/p4-vega');
    assert.deepEqual(response.entries.map((entry) => entry.position), [1, 2]);
});

test('unknown game errors retain their public code and encoded request path', async () => {
    let observedUrl;
    const api = createLeaderboardApi('', async (url) => {
        observedUrl = url;
        return Response.json(
            { success: false, contractVersion: 1, error: 'UNKNOWN_GAME' },
            { status: 404 }
        );
    });

    await assert.rejects(
        api.getGame('missing/game'),
        (error) => {
            assert.ok(error instanceof LeaderboardRequestError);
            assert.equal(error.status, 404);
            assert.equal(error.code, 'UNKNOWN_GAME');
            return true;
        }
    );
    assert.equal(observedUrl, '/api/leaderboards/missing%2Fgame');
});

test('malformed and wrong-version success responses fail closed', async () => {
    const malformedApi = createLeaderboardApi('', async () => Response.json({
        ...catalog,
        contractVersion: 2,
    }));

    await assert.rejects(
        malformedApi.getCatalog(),
        (error) => error instanceof LeaderboardRequestError
            && error.code === 'INVALID_RESPONSE'
    );

    const nonJsonApi = createLeaderboardApi('', async () => new Response('not json'));
    await assert.rejects(
        nonJsonApi.getCatalog(),
        (error) => error instanceof LeaderboardRequestError
            && error.code === 'INVALID_RESPONSE'
    );

    const wrongRulesApi = createLeaderboardApi('', async () => Response.json({
        success: true,
        contractVersion: 1,
        gameId: 'p4-vega',
        rulesVersion: 2,
        entries: [],
    }));
    await assert.rejects(
        wrongRulesApi.getGame('p4-vega'),
        (error) => error instanceof LeaderboardRequestError
            && error.code === 'INVALID_RESPONSE'
    );

    const duplicatePositionApi = createLeaderboardApi('', async () => Response.json({
        success: true,
        contractVersion: 1,
        gameId: 'p4-vega',
        rulesVersion: 1,
        entries: [
            { position: 1, userName: 'First', score: 100 },
            { position: 1, userName: 'Second', score: 90 },
        ],
    }));
    await assert.rejects(
        duplicatePositionApi.getGame('p4-vega'),
        (error) => error instanceof LeaderboardRequestError
            && error.code === 'INVALID_RESPONSE'
    );

    const tooManyEntriesApi = createLeaderboardApi('', async () => Response.json({
        success: true,
        contractVersion: 1,
        gameId: 'p4-vega',
        rulesVersion: 1,
        entries: Array.from({ length: 11 }, (_, index) => ({
            position: index + 1,
            userName: `Player ${index + 1}`,
            score: 100 - index,
        })),
    }));
    await assert.rejects(
        tooManyEntriesApi.getGame('p4-vega'),
        (error) => error instanceof LeaderboardRequestError
            && error.code === 'INVALID_RESPONSE'
    );
});

test('network failures are normalized while aborts remain aborts', async () => {
    const offlineApi = createLeaderboardApi('', async () => {
        throw new TypeError('private network detail');
    });

    await assert.rejects(
        offlineApi.getCatalog(),
        (error) => error instanceof LeaderboardRequestError
            && error.code === 'NETWORK_ERROR'
            && !error.message.includes('private network detail')
    );

    const abort = new DOMException('aborted', 'AbortError');
    const abortedApi = createLeaderboardApi('', async () => {
        throw abort;
    });
    await assert.rejects(abortedApi.getCatalog(), (error) => error === abort);
});
