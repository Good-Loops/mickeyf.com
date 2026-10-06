import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeAppleSession } from './nativeAppleSession.ts';

const apiBase = 'https://api.example.test';
const unavailable = { message: 'Could not check Apple authorization.' };

function fixture({ apple = true, state = 'authorized', response = () => Response.json({ userId: 'apple-subject' }),
    identityOverrides = {}, loadIdentity } = {}) {
    const requests = [], subjects = [], listeners = [];
    let removed = 0;
    const identity = {
        getCapabilities: async () => ({ apple }),
        getCredentialState: async input => { subjects.push(input); return { state }; },
        addListener: async (event, callback) => {
            listeners.push({ event, callback });
            return { remove: async () => { removed++; } };
        },
        ...identityOverrides,
    };
    const session = createNativeAppleSession(apiBase, async (url, init) => {
        requests.push({ url, init });
        return response();
    }, loadIdentity ?? (async () => identity));
    return { session, requests, subjects, listeners, removed: () => removed };
}

test('non-native/non-iOS identity and a disabled Apple capability perform no HTTP or native credential lookup', async () => {
    for (const options of [{ loadIdentity: async () => null }, { apple: false }]) {
        const { session, requests, subjects, listeners } = fixture(options);
        assert.equal(await session.check(), 'unchanged');
        const remove = await session.subscribe(() => assert.fail('disabled observer must not run'));
        remove();
        assert.deepEqual([requests, subjects, listeners], [[], [], []]);
    }
});

test('the cookie-authenticated endpoint selects the exact native Apple subject without caller metadata', async () => {
    const { session, requests, subjects } = fixture();
    assert.equal(await session.check(), 'unchanged');
    assert.deepEqual(requests, [{ url: `${apiBase}/auth/providers/apple-credential`,
        init: { method: 'GET', credentials: 'include' } }]);
    assert.deepEqual(subjects, [{ userId: 'apple-subject' }]);
});

test('non-Apple and missing sessions do not query an Apple credential', async () => {
    for (const [response, expected] of [
        [() => Response.json({ userId: null }), 'unchanged'],
        [() => new Response(null, { status: 401 }), 'signedOut'],
    ]) {
        const { session, subjects } = fixture({ response });
        assert.equal(await session.check(), expected);
        assert.deepEqual(subjects, []);
    }
});

for (const state of ['revoked', 'notFound']) {
    test(`${state} is positive evidence of credential loss`, async () => {
        assert.equal(await fixture({ state }).session.check(), 'revoked');
    });
}

test('transferred, unknown and malformed native states are unavailable, never evidence of revocation', async () => {
    for (const state of ['transferred', 'future-value', '', undefined, null]) {
        await assert.rejects(fixture({ identityOverrides: { getCredentialState: async () => ({ state }) } }).session.check(), unavailable);
    }
    await assert.rejects(fixture({ identityOverrides: { getCredentialState: async () => null } }).session.check(), unavailable);
});

test('malformed metadata or subject is rejected before querying Apple', async () => {
    const bodies = [null, [], {}, { subject: 'wrong-field' }, { userId: 'valid', extra: true },
        ...['', 'white space', '\nsecret', '\u007f', 'é', 'x'.repeat(256), 42, false, {}].map(userId => ({ userId }))];
    for (const body of bodies) {
        const { session, subjects } = fixture({ response: () => Response.json(body) });
        await assert.rejects(session.check(), unavailable);
        assert.deepEqual(subjects, []);
    }
});

test('identity, capability, HTTP, JSON and native outages expose only a fixed sanitized error', async () => {
    const fail = async () => { throw new Error('sensitive diagnostic apple-subject token'); };
    for (const options of [
        { loadIdentity: fail },
        { identityOverrides: { getCapabilities: fail } },
        { apple: 'true' },
        { response: fail },
        { response: () => new Response('sensitive', { status: 503 }) },
        { response: () => new Response('not-json') },
        { identityOverrides: { getCredentialState: fail } },
    ]) await assert.rejects(fixture(options).session.check(), unavailable);
});

test('a stalled native check times out and cannot turn its late revoked result into a successful check', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let finish;
    const delayed = new Promise(resolve => { finish = resolve; });
    const { session } = fixture({ identityOverrides: { getCredentialState: async () => delayed } });
    const check = session.check();
    const rejected = assert.rejects(check, unavailable);
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(10_000);
    await rejected;
    finish({ state: 'revoked' });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(check, unavailable);
});

test('native change subscription forwards only the event and removes the listener on cleanup', async () => {
    const { session, listeners, removed, requests } = fixture();
    let changes = 0;
    const remove = await session.subscribe(() => { changes++; });
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].event, 'appleCredentialChanged');
    listeners[0].callback();
    assert.equal(changes, 1);
    remove();
    assert.equal(removed(), 1);
    assert.deepEqual(requests, []);
});

test('unavailable observer and failed cleanup do not prevent later credential checks', async () => {
    for (const addListener of [
        async () => { throw new Error('observer unavailable'); },
        async () => ({ remove: async () => { throw new Error('already removed'); } }),
    ]) {
        const { session } = fixture({ identityOverrides: { addListener } });
        const remove = await session.subscribe(() => {});
        remove();
        assert.equal(await session.check(), 'unchanged');
    }
});
