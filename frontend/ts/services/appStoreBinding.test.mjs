import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppStoreBindingClient } from './appStoreBinding.ts';

const bindingProof = 'A'.repeat(43);
const signedTransaction = 'fictional.header.signature';
const available = async () => ({ kind: 'available', signedTransaction });

test('prepares a session-bound proof before reading and submitting the transaction', async () => {
    const calls = [];
    const fetcher = async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1 ? Response.json({ bindingProof }) : new Response(null, { status: 204 });
    };
    const bind = createAppStoreBindingClient('https://example.test', fetcher, { isIos: () => true, read: available });
    assert.equal(await bind({ isCurrent: () => true }), 'linked');
    assert.deepEqual(calls.map(call => call.url), [
        'https://example.test/auth/app-store/transaction/prepare', 'https://example.test/auth/app-store/transaction',
    ]);
    assert.deepEqual(JSON.parse(calls[0].init.body), {});
    assert.deepEqual(JSON.parse(calls[1].init.body), { bindingProof, signedTransaction });
    for (const { init } of calls) {
        assert.equal(init.credentials, 'include'); assert.equal(init.isCurrent(), true);
    }
});

test('ineligible, unsupported and invalid preparation never read or send a transaction', async () => {
    let reads = 0, calls = 0;
    const read = async () => { reads++; return available(); };
    const unsupported = createAppStoreBindingClient('', async () => { calls++; throw Error(); }, { isIos: () => false, read });
    assert.equal(await unsupported({ isCurrent: () => true }), 'unsupported');
    const denied = createAppStoreBindingClient('', async () => { calls++; return new Response(null, { status: 403 }); }, { isIos: () => true, read });
    assert.equal(await denied({ isCurrent: () => true }), 'not-permitted');
    const adult = createAppStoreBindingClient('', async () => { calls++; return new Response(null, { status: 204 }); }, { isIos: () => true, read });
    assert.equal(await adult({ isCurrent: () => true }), 'not-required');
    const unknown = createAppStoreBindingClient('', async () => { calls++; return new Response(null, { status: 409 }); }, { isIos: () => true, read });
    assert.equal(await unknown({ isCurrent: () => true }), 'unknown-age');
    const malformed = createAppStoreBindingClient('', async () => { calls++; return Response.json({ bindingProof, extra: true }); }, { isIos: () => true, read });
    assert.equal(await malformed({ isCurrent: () => true }), 'unavailable');
    assert.equal(reads, 0); assert.equal(calls, 4);
});

test('a session change while the native transaction is being read prevents submission', async () => {
    let current = true, calls = 0;
    const bind = createAppStoreBindingClient('', async () => { calls++; return Response.json({ bindingProof }); }, {
        isIos: () => true, async read() { current = false; return available(); },
    });
    assert.equal(await bind({ isCurrent: () => current }), 'cancelled');
    assert.equal(calls, 1);
    const controller = new AbortController(); controller.abort();
    assert.equal(await bind({ signal: controller.signal, isCurrent: () => true }), 'cancelled');
    assert.equal(calls, 1);
});
