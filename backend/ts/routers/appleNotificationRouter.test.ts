import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import {
    createAppleNotificationVerifier, type AppleNotificationVerifier,
    type AppleNotificationVerificationResult, type VerifiedAppleNotification,
} from '../auth/appleNotificationVerifier';
import { notFoundHandler, requestErrorHandler } from '../middleware/errorHandling';
import { createAppleNotificationRouter } from './appleNotificationRouter';

const notification = Object.freeze({ audience: 'com.example.app', subject: 'private-apple-subject',
    eventType: 'consent-revoked', issuedAt: 1_800_000_000, eventTime: 1_799_999_998 }) as VerifiedAppleNotification;
const accepted = { verified: true, notification } as const;
const payload = 'synthetic-signed-notification';

async function withServer(
    run: (url: string, state: {
        verified: unknown[]; applied: VerifiedAppleNotification[];
        result: AppleNotificationVerificationResult; storageFailure: boolean;
        beforeApply?: () => Promise<void>;
    }) => Promise<void>,
    options: { enabled?: boolean; verifier?: AppleNotificationVerifier } = {},
) {
    const state = { verified: [] as unknown[], applied: [] as VerifiedAppleNotification[],
        result: accepted as AppleNotificationVerificationResult, storageFailure: false,
        beforeApply: undefined as (() => Promise<void>) | undefined };
    const verifier = options.verifier ?? { async verify(token: unknown) {
        state.verified.push(token);
        return state.result;
    } };
    const app = express();
    // Match app.ts: production parses /auth JSON before mounting the auth router.
    app.use(express.json({ limit: '32kb', strict: true }));
    app.use('/auth/apple/notifications', createAppleNotificationRouter(options.enabled === false ? undefined : verifier,
        async verified => {
            if (state.beforeApply) await state.beforeApply();
            if (state.storageFailure) throw new Error('private SQL, subject and credential details');
            state.applied.push(verified);
        }));
    app.use(notFoundHandler);
    app.use(requestErrorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/apple/notifications`, state); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

function post(url: string, body: unknown = { payload }, headers: Record<string, string> = {}) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body) });
}

test('disabled notification route stays absent without verification or mutation', async () => {
    await withServer(async (url, state) => {
        const response = await post(url);
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: 'NOT_FOUND' });
        assert.deepEqual(state.verified, []);
        assert.deepEqual(state.applied, []);
    }, { enabled: false });
});

test('Apple signature is sufficient without browser cookies, bearer auth, origin or caller-selected account', async () => {
    await withServer(async (url, state) => {
        const headerVariants: Record<string, string>[] = [{}, { cookie: '__session=untrusted',
            authorization: 'Bearer untrusted', origin: 'https://untrusted.invalid' }];
        for (const headers of headerVariants) {
            const response = await post(url, { payload }, headers);
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { received: true });
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.equal(response.headers.get('set-cookie'), null);
        }
        assert.deepEqual(state.verified, [payload, payload]);
        assert.deepEqual(state.applied, [notification, notification]);
    });
});

test('only the exact bounded JSON payload envelope reaches verification', async () => {
    await withServer(async (url, state) => {
        for (const body of [{}, { payload: 42 }, { payload: null }, { payload: [] }, [],
            { payload: 'a'.repeat(16_385) }, { payload, sub: notification.subject },
            { payload, accountId: 'request-selected-account' }, { payload, events: {} }]) {
            const response = await post(url, body);
            assert.equal(response.status, 400);
            assert.deepEqual(await response.json(), { error: 'INVALID_APPLE_NOTIFICATION' });
        }
        const nonJson = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: payload });
        assert.equal(nonJson.status, 400);
        assert.deepEqual(await nonJson.json(), { error: 'INVALID_APPLE_NOTIFICATION' });
        assert.deepEqual(state.verified, []);
        assert.deepEqual(state.applied, []);
    });
});

test('malformed and excessive JSON use the global sanitized parser errors without authentication work', async () => {
    await withServer(async (url, state) => {
        for (const [body, status, error] of [['{"payload":', 400, 'INVALID_REQUEST'],
            [JSON.stringify({ payload: 'a'.repeat(33_000) }), 413, 'PAYLOAD_TOO_LARGE']] as const) {
            const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
            assert.equal(response.status, status);
            assert.deepEqual(await response.json(), { error });
        }
        assert.deepEqual(state.verified, []);
        assert.deepEqual(state.applied, []);
    });
});

test('production parser permits whitespace within the 32 KiB envelope while payload stays independently bounded', async () => {
    await withServer(async (url, state) => {
        const body = `{${' '.repeat(21_000)}${JSON.stringify({ payload }).slice(1)}`;
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { received: true });
        assert.deepEqual(state.verified, [payload]);
        assert.deepEqual(state.applied, [notification]);
    });
});

test('actual verifier rejects an unsigned notification before any keys or mutations', async () => {
    const verifier = createAppleNotificationVerifier({ audiences: [notification.audience] }, {
        fetch: async () => { assert.fail('Malformed notifications must not fetch verification keys'); },
    });
    await withServer(async (url, state) => {
        const response = await post(url, { payload: 'not-a-signed-apple-notification' });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: 'INVALID_APPLE_NOTIFICATION' });
        assert.deepEqual(state.applied, []);
    }, { verifier });
});

test('key/configuration outages return retryable 503; invalid signatures return 400, all without PII', async () => {
    await withServer(async (url, state) => {
        for (const reason of ['INVALID_APPLE_NOTIFICATION', 'APPLE_KEYS_UNAVAILABLE', 'APPLE_NOT_CONFIGURED'] as const) {
            state.result = { verified: false, reason };
            const response = await post(url);
            assert.equal(response.status, reason === 'INVALID_APPLE_NOTIFICATION' ? 400 : 503);
            assert.deepEqual(await response.json(), { error: reason === 'INVALID_APPLE_NOTIFICATION'
                ? 'INVALID_APPLE_NOTIFICATION' : 'UNAVAILABLE' });
        }
        assert.deepEqual(state.applied, []);
    });
});

test('successful HTTP acknowledgment waits for completed application and redelivery retries storage failure', async () => {
    await withServer(async (url, state) => {
        let reached!: () => void;
        let release!: () => void;
        const applying = new Promise<void>(resolve => { reached = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        state.beforeApply = async () => { reached(); await gate; };
        let acknowledged = false;
        const pending = post(url).then(response => { acknowledged = true; return response; });
        try {
            await applying;
            assert.equal(acknowledged, false);
            assert.deepEqual(state.applied, []);
        } finally { release(); }
        assert.equal((await pending).status, 200);
        state.beforeApply = undefined;
        state.storageFailure = true;
        const failure = await post(url);
        assert.equal(failure.status, 503);
        assert.deepEqual(await failure.json(), { error: 'UNAVAILABLE' });
        assert.equal(state.applied.length, 1);
        state.storageFailure = false;
        assert.equal((await post(url)).status, 200);
        assert.deepEqual(state.applied, [notification, notification]);
    });
});

test('email events are acknowledged through the verified consumer without leaking event metadata', async () => {
    await withServer(async (url, state) => {
        for (const eventType of ['email-enabled', 'email-disabled'] as const) {
            state.result = { verified: true, notification: Object.freeze({ ...notification, eventType }) };
            const response = await post(url);
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { received: true });
        }
        assert.equal(state.applied.length, 2);
    });
});
