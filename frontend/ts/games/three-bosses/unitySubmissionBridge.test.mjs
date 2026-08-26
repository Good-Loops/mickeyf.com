import assert from 'node:assert/strict';
import test from 'node:test';
import { LeaderboardRequestError } from '../../services/leaderboardApi.ts';
import {
    bindThreeBossesSubmissionBridge,
    THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION,
    THREE_BOSSES_SUBMISSION_RECEIVER_OBJECT,
    THREE_BOSSES_SUBMISSION_RESULT_METHOD,
} from './unitySubmissionBridge.ts';

const firstPayload = {
    runId: '550e8400-e29b-41d4-a716-446655440000',
    completionTimeMs: 60_000,
};
const secondPayload = {
    runId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
    completionTimeMs: 59_000,
};

const responseFor = (payload, replayed = false) => ({
    success: true,
    contractVersion: 1,
    gameId: 'three-bosses',
    rulesVersion: 1,
    runId: payload.runId,
    replayed,
    personalBest: !replayed,
    result: {
        score: payload.completionTimeMs === 60_000 ? 1_667 : 1_695,
        completionTimeMs: payload.completionTimeMs,
        rank: 'UNRANKED',
    },
});

const createInstance = () => {
    const messages = [];
    return {
        instance: {
            SendMessage: (...message) => messages.push(message),
        },
        messages,
    };
};

const callbackAt = (messages, index) => JSON.parse(messages[index][2]);
const flush = () => new Promise((resolve) => setImmediate(resolve));

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
};

test('installs the stable Unity contract and submits only canonical run metrics', async () => {
    const bridgeWindow = {};
    const { instance, messages } = createInstance();
    const requests = [];
    const signals = [];
    const cleanup = bindThreeBossesSubmissionBridge(
        instance,
        async (request, signal) => {
            requests.push(request);
            signals.push(signal);
            return responseFor(firstPayload);
        },
        bridgeWindow,
    );

    assert.equal(typeof bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION], 'function');
    bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION](JSON.stringify(firstPayload));
    await flush();

    assert.deepEqual(requests, [{
        contractVersion: 1,
        rulesVersion: 1,
        runId: firstPayload.runId,
        completionTimeMs: firstPayload.completionTimeMs,
    }]);
    assert.equal(signals[0] instanceof AbortSignal, true);
    assert.deepEqual(messages[0].slice(0, 2), [
        THREE_BOSSES_SUBMISSION_RECEIVER_OBJECT,
        THREE_BOSSES_SUBMISSION_RESULT_METHOD,
    ]);
    assert.deepEqual(callbackAt(messages, 0), {
        success: true,
        runId: firstPayload.runId,
        response: responseFor(firstPayload),
    });
    assert.equal(JSON.stringify(requests).includes('token'), false);
    assert.equal(JSON.stringify(messages).includes('session'), false);

    cleanup();
    assert.equal(bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION], undefined);
});

test('coalesces an identical in-flight call and rejects overlapping different data', async () => {
    const bridgeWindow = {};
    const { instance, messages } = createInstance();
    const pending = deferred();
    let submitCount = 0;
    const cleanup = bindThreeBossesSubmissionBridge(
        instance,
        async () => {
            submitCount += 1;
            return pending.promise;
        },
        bridgeWindow,
    );

    const submit = bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION];
    submit(JSON.stringify(firstPayload));
    submit(JSON.stringify(firstPayload));
    submit(JSON.stringify(secondPayload));

    assert.equal(submitCount, 1);
    assert.deepEqual(callbackAt(messages, 0), {
        success: false,
        runId: secondPayload.runId,
        status: 409,
        error: 'IDEMPOTENCY_CONFLICT',
    });

    pending.resolve(responseFor(firstPayload));
    await flush();
    assert.equal(messages.length, 2);
    assert.equal(callbackAt(messages, 1).success, true);
    cleanup();
});

test('uncertain failures permit only an exact retry until the server confirms it', async () => {
    const bridgeWindow = {};
    const { instance, messages } = createInstance();
    const requests = [];
    let attempt = 0;
    const cleanup = bindThreeBossesSubmissionBridge(
        instance,
        async (request) => {
            requests.push(request);
            attempt += 1;
            if (attempt === 1) {
                throw new LeaderboardRequestError(
                    'Unable to reach the leaderboard service.',
                    0,
                    'NETWORK_ERROR',
                );
            }
            return responseFor(firstPayload, true);
        },
        bridgeWindow,
    );

    const submit = bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION];
    submit(JSON.stringify(firstPayload));
    await flush();
    assert.deepEqual(callbackAt(messages, 0), {
        success: false,
        runId: firstPayload.runId,
        status: 0,
        error: 'NETWORK_ERROR',
    });

    submit(JSON.stringify(secondPayload));
    assert.deepEqual(callbackAt(messages, 1), {
        success: false,
        runId: secondPayload.runId,
        status: 409,
        error: 'IDEMPOTENCY_CONFLICT',
    });
    assert.equal(requests.length, 1);

    submit(JSON.stringify(firstPayload));
    await flush();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], requests[0]);
    assert.deepEqual(callbackAt(messages, 2), {
        success: true,
        runId: firstPayload.runId,
        response: responseFor(firstPayload, true),
    });
    cleanup();
});

test('serializes typed API failures without exposing their private messages', async () => {
    const bridgeWindow = {};
    const { instance, messages } = createInstance();
    const cleanup = bindThreeBossesSubmissionBridge(
        instance,
        async () => {
            throw new LeaderboardRequestError('private diagnostic', 401, 'UNAUTHORIZED');
        },
        bridgeWindow,
    );

    bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION](JSON.stringify(firstPayload));
    await flush();

    assert.deepEqual(callbackAt(messages, 0), {
        success: false,
        runId: firstPayload.runId,
        status: 401,
        error: 'UNAUTHORIZED',
    });
    assert.equal(messages[0][2].includes('private diagnostic'), false);
    cleanup();
});

test('rejects malformed or expanded Unity payloads before network work', () => {
    const bridgeWindow = {};
    const { instance, messages } = createInstance();
    let submitCount = 0;
    const cleanup = bindThreeBossesSubmissionBridge(
        instance,
        async () => {
            submitCount += 1;
            return responseFor(firstPayload);
        },
        bridgeWindow,
    );
    const submit = bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION];

    for (const value of [
        'not-json',
        JSON.stringify({ ...firstPayload, score: 1_667 }),
        JSON.stringify({ ...firstPayload, runId: firstPayload.runId.toUpperCase() }),
        JSON.stringify({ ...firstPayload, completionTimeMs: 0 }),
    ]) {
        submit(value);
    }

    assert.equal(submitCount, 0);
    assert.equal(messages.length, 4);
    for (const message of messages) {
        assert.deepEqual(JSON.parse(message[2]), {
            success: false,
            runId: null,
            status: 400,
            error: 'INVALID_RUN',
        });
    }
    cleanup();
});

test('cleanup aborts active work, removes only its global, and suppresses late callbacks', async () => {
    const bridgeWindow = {};
    const { instance, messages } = createInstance();
    const pending = deferred();
    let observedSignal;
    const cleanup = bindThreeBossesSubmissionBridge(
        instance,
        async (_request, signal) => {
            observedSignal = signal;
            return pending.promise;
        },
        bridgeWindow,
    );

    bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION](JSON.stringify(firstPayload));
    cleanup();
    cleanup();

    assert.equal(observedSignal.aborted, true);
    assert.equal(bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION], undefined);
    pending.resolve(responseFor(firstPayload));
    await flush();
    assert.deepEqual(messages, []);
});
