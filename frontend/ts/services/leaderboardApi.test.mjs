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

const runSubmission = {
    contractVersion: 1,
    rulesVersion: 1,
    runId: '550e8400-e29b-41d4-a716-446655440000',
    completionTimeMs: 60_000,
};

const runSubmissionResponse = {
    success: true,
    contractVersion: 1,
    gameId: 'three-bosses',
    rulesVersion: 1,
    runId: runSubmission.runId,
    replayed: false,
    personalBest: true,
    result: {
        score: 1_667,
        completionTimeMs: runSubmission.completionTimeMs,
        rank: 'UNRANKED',
    },
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

test('Three Bosses submission sends the exact cookie-bearing JSON contract', async () => {
    let observedUrl;
    let observedInit;
    const controller = new AbortController();
    const api = createLeaderboardApi('https://api.example.test/', async (url, init) => {
        observedUrl = url;
        observedInit = init;
        return Response.json(runSubmissionResponse, { status: 201 });
    });

    assert.deepEqual(
        await api.submitThreeBossesRun(runSubmission, controller.signal),
        runSubmissionResponse,
    );
    assert.equal(observedUrl, 'https://api.example.test/api/leaderboards/three-bosses/runs');
    assert.equal(observedInit.method, 'POST');
    assert.equal(observedInit.credentials, 'include');
    assert.deepEqual(observedInit.headers, {
        Accept: 'application/json',
        'Content-Type': 'application/json',
    });
    assert.equal(observedInit.body, JSON.stringify(runSubmission));
    assert.equal(observedInit.signal, controller.signal);
    assert.equal(observedInit.headers.Authorization, undefined);
});

test('Three Bosses exact replays require HTTP 200 and retain the typed result', async () => {
    const replay = {
        ...runSubmissionResponse,
        replayed: true,
        personalBest: false,
    };
    const api = createLeaderboardApi('', async () => Response.json(replay));

    assert.deepEqual(await api.submitThreeBossesRun(runSubmission), replay);
});

test('Three Bosses submission preserves every versioned API error and status', async () => {
    const cases = [
        ['UNKNOWN_GAME', 404],
        ['SUBMISSION_DISABLED', 403],
        ['UNSUPPORTED_CONTRACT_VERSION', 400],
        ['UNSUPPORTED_RULES_VERSION', 400],
        ['INVALID_RUN', 400],
        ['UNAUTHORIZED', 401],
        ['IDEMPOTENCY_CONFLICT', 409],
        ['RATE_LIMITED', 429],
        ['SERVER_ERROR', 500],
    ];

    for (const [code, status] of cases) {
        const api = createLeaderboardApi('', async () => Response.json(
            { success: false, contractVersion: 1, error: code },
            { status },
        ));

        await assert.rejects(
            api.submitThreeBossesRun(runSubmission),
            (error) => error instanceof LeaderboardRequestError
                && error.code === code
                && error.status === status,
            `${code} did not retain its public status`,
        );
    }
});

test('Three Bosses submission rejects invalid local input before fetch', async () => {
    let fetchCount = 0;
    const api = createLeaderboardApi('', async () => {
        fetchCount += 1;
        throw new Error('fetch must not run');
    });

    for (const invalidRequest of [
        { ...runSubmission, contractVersion: 2 },
        { ...runSubmission, rulesVersion: 2 },
        { ...runSubmission, runId: runSubmission.runId.toUpperCase() },
        { ...runSubmission, completionTimeMs: 0 },
        { ...runSubmission, score: 1_667 },
    ]) {
        await assert.rejects(
            api.submitThreeBossesRun(invalidRequest),
            (error) => error instanceof LeaderboardRequestError
                && error.status === 400,
        );
    }
    assert.equal(fetchCount, 0);
});

test('Three Bosses submission fails closed on malformed success and error responses', async () => {
    const malformedSuccesses = [
        { ...runSubmissionResponse, runId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8' },
        { ...runSubmissionResponse, result: { ...runSubmissionResponse.result, completionTimeMs: 60_001 } },
        { ...runSubmissionResponse, unexpected: true },
    ];

    for (const malformed of malformedSuccesses) {
        const api = createLeaderboardApi('', async () => Response.json(malformed, { status: 201 }));
        await assert.rejects(
            api.submitThreeBossesRun(runSubmission),
            (error) => error instanceof LeaderboardRequestError
                && error.code === 'INVALID_RESPONSE',
        );
    }

    const wrongSuccessStatus = createLeaderboardApi('', async () =>
        Response.json(runSubmissionResponse, { status: 200 }));
    await assert.rejects(
        wrongSuccessStatus.submitThreeBossesRun(runSubmission),
        (error) => error instanceof LeaderboardRequestError
            && error.code === 'INVALID_RESPONSE',
    );

    const wrongErrorStatus = createLeaderboardApi('', async () => Response.json(
        { success: false, contractVersion: 1, error: 'UNAUTHORIZED' },
        { status: 403 },
    ));
    await assert.rejects(
        wrongErrorStatus.submitThreeBossesRun(runSubmission),
        (error) => error instanceof LeaderboardRequestError
            && error.code === 'INVALID_RESPONSE',
    );
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

    const abortedBodyApi = createLeaderboardApi('', async () => ({
        ok: true,
        status: 200,
        json: async () => {
            throw abort;
        },
    }));
    await assert.rejects(abortedBodyApi.getCatalog(), (error) => error === abort);
});
