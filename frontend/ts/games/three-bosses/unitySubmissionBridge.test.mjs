import assert from 'node:assert/strict';
import test from 'node:test';
import { LeaderboardRequestError } from '../../services/leaderboardApi.ts';
import {
    bindThreeBossesSubmissionBridge,
    configureThreeBossesSubmission,
    THREE_BOSSES_RUN_BEGIN_BRIDGE_FUNCTION,
    THREE_BOSSES_RUN_TICKET_UNAVAILABLE_ERROR,
    THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION,
    THREE_BOSSES_SUBMISSION_CONFIGURE_METHOD,
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

const ticketFor = (runId) => ({
    success: true,
    contractVersion: 1,
    gameId: 'three-bosses',
    rulesVersion: 1,
    runId,
    runTicket: `signed-ticket-for-${runId}`,
    expiresAt: '2026-08-31T12:30:00.000Z',
});

const issueTicket = async (request) => ticketFor(request.runId);

const responseFor = (payload, replayed = false) => ({
    success: true,
    contractVersion: 1,
    gameId: 'three-bosses',
    rulesVersion: 1,
    runId: payload.runId,
    replayed,
    personalBest: !replayed,
    result: {
        score: payload.completionTimeMs === 60_000 ? 166_667 : 169_492,
        completionTimeMs: payload.completionTimeMs,
        rank: payload.completionTimeMs === 60_000 ? 'A' : 'S',
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

test('configures Unity from the server-owned submission gate', () => {
    const { instance, messages } = createInstance();

    configureThreeBossesSubmission(instance, false);
    configureThreeBossesSubmission(instance, true);

    assert.deepEqual(messages, [
        [
            THREE_BOSSES_SUBMISSION_RECEIVER_OBJECT,
            THREE_BOSSES_SUBMISSION_CONFIGURE_METHOD,
            '0',
        ],
        [
            THREE_BOSSES_SUBMISSION_RECEIVER_OBJECT,
            THREE_BOSSES_SUBMISSION_CONFIGURE_METHOD,
            '1',
        ],
    ]);
});

test('installs the stable Unity contract and submits only canonical run metrics', async () => {
    const bridgeWindow = {};
    const { instance, messages } = createInstance();
    const ticketRequests = [];
    const requests = [];
    const signals = [];
    const cleanup = bindThreeBossesSubmissionBridge(
        instance,
        async (request, signal) => {
            ticketRequests.push(request);
            signals.push(signal);
            return ticketFor(request.runId);
        },
        async (request, signal) => {
            requests.push(request);
            signals.push(signal);
            return responseFor(firstPayload);
        },
        bridgeWindow,
    );

    assert.equal(typeof bridgeWindow[THREE_BOSSES_RUN_BEGIN_BRIDGE_FUNCTION], 'function');
    assert.equal(typeof bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION], 'function');
    bridgeWindow[THREE_BOSSES_RUN_BEGIN_BRIDGE_FUNCTION](firstPayload.runId);
    bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION](JSON.stringify(firstPayload));
    await flush();

    assert.deepEqual(ticketRequests, [{
        contractVersion: 1,
        rulesVersion: 1,
        runId: firstPayload.runId,
    }]);
    assert.deepEqual(requests, [{
        contractVersion: 1,
        rulesVersion: 1,
        runId: firstPayload.runId,
        completionTimeMs: firstPayload.completionTimeMs,
        runTicket: ticketFor(firstPayload.runId).runTicket,
    }]);
    assert.equal(signals.every((signal) => signal instanceof AbortSignal), true);
    assert.deepEqual(messages[0].slice(0, 2), [
        THREE_BOSSES_SUBMISSION_RECEIVER_OBJECT,
        THREE_BOSSES_SUBMISSION_RESULT_METHOD,
    ]);
    assert.deepEqual(callbackAt(messages, 0), {
        success: true,
        runId: firstPayload.runId,
        response: responseFor(firstPayload),
    });
    assert.equal(JSON.stringify(messages).includes(ticketFor(firstPayload.runId).runTicket), false);
    assert.equal(JSON.stringify(messages).includes('session'), false);

    cleanup();
    assert.equal(bridgeWindow[THREE_BOSSES_RUN_BEGIN_BRIDGE_FUNCTION], undefined);
    assert.equal(bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION], undefined);
});

test('fails closed when Unity submits a run that never received a start ticket', () => {
    const bridgeWindow = {};
    const { instance, messages } = createInstance();
    let ticketCount = 0;
    let submitCount = 0;
    const cleanup = bindThreeBossesSubmissionBridge(
        instance,
        async () => {
            ticketCount += 1;
            return ticketFor(firstPayload.runId);
        },
        async () => {
            submitCount += 1;
            return responseFor(firstPayload);
        },
        bridgeWindow,
    );

    bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION](JSON.stringify(firstPayload));

    assert.equal(ticketCount, 0);
    assert.equal(submitCount, 0);
    assert.deepEqual(callbackAt(messages, 0), {
        success: false,
        runId: firstPayload.runId,
        status: 400,
        error: 'INVALID_RUN',
    });
    cleanup();
});

test('a new run aborts and replaces the prior in-memory ticket', async () => {
    const bridgeWindow = {};
    const { instance, messages } = createInstance();
    const firstTicket = deferred();
    const ticketSignals = [];
    const ticketRequests = [];
    const cleanup = bindThreeBossesSubmissionBridge(
        instance,
        async (request, signal) => {
            ticketRequests.push(request);
            ticketSignals.push(signal);
            return request.runId === firstPayload.runId
                ? firstTicket.promise
                : ticketFor(request.runId);
        },
        async (request) => responseFor({
            runId: request.runId,
            completionTimeMs: request.completionTimeMs,
        }),
        bridgeWindow,
    );

    const begin = bridgeWindow[THREE_BOSSES_RUN_BEGIN_BRIDGE_FUNCTION];
    begin(firstPayload.runId);
    await flush();
    begin(secondPayload.runId);
    await flush();

    assert.deepEqual(ticketRequests.map(({ runId }) => runId), [
        firstPayload.runId,
        secondPayload.runId,
    ]);
    assert.equal(ticketSignals[0].aborted, true);
    assert.equal(ticketSignals[1].aborted, false);

    bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION](JSON.stringify(secondPayload));
    await flush();
    assert.equal(callbackAt(messages, 0).success, true);
    cleanup();
});

test('requires a new run after ticket issuance fails instead of exposing a false retry', async () => {
    const bridgeWindow = {};
    const { instance, messages } = createInstance();
    let submitCount = 0;
    const cleanup = bindThreeBossesSubmissionBridge(
        instance,
        async () => {
            throw new LeaderboardRequestError(
                'private authentication detail',
                401,
                'UNAUTHORIZED',
            );
        },
        async () => {
            submitCount += 1;
            return responseFor(firstPayload);
        },
        bridgeWindow,
    );

    bridgeWindow[THREE_BOSSES_RUN_BEGIN_BRIDGE_FUNCTION](firstPayload.runId);
    await flush();
    assert.deepEqual(messages, []);

    bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION](JSON.stringify(firstPayload));
    await flush();
    assert.equal(submitCount, 0);
    assert.deepEqual(callbackAt(messages, 0), {
        success: false,
        runId: firstPayload.runId,
        status: 401,
        error: THREE_BOSSES_RUN_TICKET_UNAVAILABLE_ERROR,
    });
    assert.equal(messages[0][2].includes('private authentication detail'), false);

    bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION](JSON.stringify(firstPayload));
    await flush();
    assert.equal(submitCount, 0);
    assert.equal(messages.length, 2);
    assert.equal(
        callbackAt(messages, 1).error,
        THREE_BOSSES_RUN_TICKET_UNAVAILABLE_ERROR,
    );
    cleanup();
});

test('coalesces an identical in-flight call and rejects overlapping different data', async () => {
    const bridgeWindow = {};
    const { instance, messages } = createInstance();
    const pending = deferred();
    let submitCount = 0;
    const cleanup = bindThreeBossesSubmissionBridge(
        instance,
        issueTicket,
        async () => {
            submitCount += 1;
            return pending.promise;
        },
        bridgeWindow,
    );

    const submit = bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION];
    bridgeWindow[THREE_BOSSES_RUN_BEGIN_BRIDGE_FUNCTION](firstPayload.runId);
    submit(JSON.stringify(firstPayload));
    submit(JSON.stringify(firstPayload));
    submit(JSON.stringify(secondPayload));
    await flush();

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
        issueTicket,
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
    bridgeWindow[THREE_BOSSES_RUN_BEGIN_BRIDGE_FUNCTION](firstPayload.runId);
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

test('times out a stalled request and permits only the exact run retry', async () => {
    const bridgeWindow = {};
    const { instance, messages } = createInstance();
    const stalled = deferred();
    const observedSignals = [];
    let attempt = 0;
    const cleanup = bindThreeBossesSubmissionBridge(
        instance,
        issueTicket,
        async (_request, signal) => {
            observedSignals.push(signal);
            attempt += 1;
            return attempt === 1 ? stalled.promise : responseFor(firstPayload, true);
        },
        bridgeWindow,
        5,
    );

    const submit = bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION];
    bridgeWindow[THREE_BOSSES_RUN_BEGIN_BRIDGE_FUNCTION](firstPayload.runId);
    submit(JSON.stringify(firstPayload));
    await new Promise((resolve) => setTimeout(resolve, 15));

    assert.equal(observedSignals[0].aborted, true);
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

    submit(JSON.stringify(firstPayload));
    await flush();
    assert.equal(attempt, 2);
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
        issueTicket,
        async () => {
            throw new LeaderboardRequestError('private diagnostic', 401, 'UNAUTHORIZED');
        },
        bridgeWindow,
    );

    bridgeWindow[THREE_BOSSES_RUN_BEGIN_BRIDGE_FUNCTION](firstPayload.runId);
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
        issueTicket,
        async () => {
            submitCount += 1;
            return responseFor(firstPayload);
        },
        bridgeWindow,
    );
    const submit = bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION];

    for (const value of [
        'not-json',
        JSON.stringify({ ...firstPayload, score: 166_667 }),
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
        issueTicket,
        async (_request, signal) => {
            observedSignal = signal;
            return pending.promise;
        },
        bridgeWindow,
    );

    bridgeWindow[THREE_BOSSES_RUN_BEGIN_BRIDGE_FUNCTION](firstPayload.runId);
    bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION](JSON.stringify(firstPayload));
    await flush();
    cleanup();
    cleanup();

    assert.equal(observedSignal.aborted, true);
    assert.equal(bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION], undefined);
    pending.resolve(responseFor(firstPayload));
    await flush();
    assert.deepEqual(messages, []);
});
