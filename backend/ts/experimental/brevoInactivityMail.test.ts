import assert from 'node:assert/strict';
import test from 'node:test';
import { NONRESPONSE_NOTICE, NONRESPONSE_NOTICE_DIGEST } from './childInactivityNonresponsePolicy';
import { observeBrevoInactivityWarning, sendBrevoInactivityWarning, type WarningAttempt, type WarningBinding } from './brevoInactivityMail';

const key = 'synthetic-api-key-only';
const now = Date.parse('2031-02-01T00:00:00Z');
const attempt: WarningAttempt = { attemptId: '12345678-1234-4234-8234-123456789abc',
    sender: 'notice@example.test', recipient: 'parent@example.test', language: 'en', noticeDigest: NONRESPONSE_NOTICE_DIGEST };
const messageId = '<synthetic.123@example.test>';
const binding: WarningBinding = { sender: attempt.sender, recipient: attempt.recipient, messageId, notBeforeMs: now - 10_000 };
const event = { messageId, email: binding.recipient, from: binding.sender, event: 'delivered', date: '2031-01-31T23:59:59Z' };
type Fetch = typeof fetch;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const fake = (run: (url: string, init: RequestInit) => Promise<Response> | Response): Fetch =>
    ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(run(String(url), init ?? {}))) as Fetch;

test('one attempt sends exactly one recipient the fixed, version-bound notice', async () => {
    let calls = 0;
    const result = await sendBrevoInactivityWarning(key, attempt, fake((url, init) => {
        calls++;
        assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
        assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
        assert.deepEqual(init.headers, { 'api-key': key, accept: 'application/json', 'content-type': 'application/json' });
        const body = JSON.parse(String(init.body));
        assert.deepEqual(body.sender, { email: attempt.sender });
        assert.deepEqual(body.to, [{ email: attempt.recipient, contactPixelTrackingConsent: false }]);
        assert.deepEqual(body.replyTo, { email: 'mickeyf.plays@gmail.com' });
        assert.equal(body.headers.idempotencyKey, attempt.attemptId);
        assert.match(body.textContent, /https:\/\/mickeyf\.com\/parent-accounts/u);
        assert.ok(body.textContent.startsWith(NONRESPONSE_NOTICE.en));
        assert.equal(body.cc, undefined); assert.equal(body.bcc, undefined); assert.equal(body.attachment, undefined);
        return response({ messageId });
    }));
    assert.deepEqual(result, { kind: 'accepted', messageId }); assert.equal(calls, 1);
    const pt = await sendBrevoInactivityWarning(key, { ...attempt, language: 'pt-BR' }, fake((_url, init) => {
        assert.ok(JSON.parse(String(init.body)).textContent.startsWith(NONRESPONSE_NOTICE.ptBR));
        return response({ messageId });
    }));
    assert.equal(pt.kind, 'accepted');
});

test('send errors, malformed replies and server failures are uncertain, with no retry', async () => {
    for (const run of [() => { throw new Error('secret or address must not escape'); },
        () => response({ messageId }, 429), () => response({ messageId: 'not-an-id' }),
        () => new Response('{broken', { status: 200 }), () => new Response('x'.repeat(128 * 1024 + 1))]) {
        let calls = 0;
        assert.deepEqual(await sendBrevoInactivityWarning(key, attempt, fake(() => { calls++; return run(); })), { kind: 'uncertain' });
        assert.equal(calls, 1);
    }
});

test('invalid attempt, changed notice or unsafe inputs fail before contacting the provider', async () => {
    let calls = 0; const noNetwork = fake(() => { calls++; return response({ messageId }); });
    for (const changed of [{ ...attempt, noticeDigest: 'x'.repeat(64) }, { ...attempt, attemptId: 'bad' },
        { ...attempt, recipient: 'name@example.test\r\nBcc:evil@example.test' }, { ...attempt, sender: 'not an email' }]) {
        await assert.rejects(sendBrevoInactivityWarning(key, changed, noNetwork), TypeError);
    }
    await assert.rejects(sendBrevoInactivityWarning('short', attempt, noNetwork), TypeError);
    assert.equal(calls, 0);
});

test('provider observations bind message, recipient and sender and do not assert inbox placement', async () => {
    const received = await observeBrevoInactivityWarning(key, binding, now, fake((url, init) => {
        const parsed = new URL(url);
        assert.equal(parsed.origin, 'https://api.brevo.com');
        assert.equal(parsed.pathname, '/v3/smtp/statistics/events');
        assert.equal(parsed.searchParams.get('messageId'), messageId);
        assert.equal(parsed.searchParams.get('email'), null);
        assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
        assert.equal((init.headers as Record<string, string>)['cache-control'], 'no-cache, no-store');
        return response({ events: [event] });
    }));
    assert.deepEqual(received, { kind: 'delivered', observedAt: '2031-02-01T00:00:00.000Z' });
});

test('bounces, provider errors, mismatches, incomplete reports and unknown events hold', async () => {
    const checks: unknown[] = [null, {}, { events: [] }, { events: Array(100).fill(event) },
        { events: [{ ...event, messageId: '<other@example.test>' }] }, { events: [{ ...event, email: 'other@example.test' }] },
        { events: [{ ...event, from: 'other@example.test' }] }, { events: [{ ...event, date: '2031-02-30T00:00:00Z' }] },
        { events: [{ ...event, date: '2031-02-01T00:00:01Z' }] }, { events: [{ ...event, event: 'new-provider-event' }] }];
    for (const name of ['hardBounce', 'softBounce', 'hard_bounce', 'soft_bounce', 'deferred', 'blocked', 'invalid', 'invalid_email', 'error', 'spam', 'unsubscribed',
        'opened', 'uniqueOpened', 'click', 'proxy_open', 'unique_proxy_open']) {
        checks.push({ events: [event, { ...event, event: name }] });
    }
    for (const body of checks) assert.deepEqual(await observeBrevoInactivityWarning(key, binding, now, fake(() => response(body))), { kind: 'hold' });
    assert.deepEqual(await observeBrevoInactivityWarning(key, binding, now, fake(() => response({}, 503))), { kind: 'hold' });
    assert.deepEqual(await observeBrevoInactivityWarning(key, binding, now, fake(() => { throw new Error('unavailable'); })), { kind: 'hold' });
    let calls = 0;
    assert.deepEqual(await observeBrevoInactivityWarning(key, { ...binding, notBeforeMs: now - 90 * 86_400_000 }, now,
        fake(() => { calls++; return response({ events: [event] }); })), { kind: 'hold' });
    assert.equal(calls, 0);
});

test('duplicate and unordered deliveries choose the latest time while failures always hold', async () => {
    const earlier = { ...event, date: '2031-01-31T23:59:58.100Z' };
    const later = { ...event, date: '2031-01-31T23:59:59.123Z' };
    const send = { ...event, event: 'request', date: '2031-01-31T23:59:58Z' };
    for (const events of [[earlier, later, send, later], [send, later, earlier]]) {
        assert.deepEqual(await observeBrevoInactivityWarning(key, binding, now, fake(() => response({ events }))),
            { kind: 'delivered', observedAt: '2031-01-31T23:59:59.124Z' });
    }
    assert.deepEqual(await observeBrevoInactivityWarning(key, binding, now, fake(() => response({ events: [
        { ...event, event: 'hardBounce' }, later,
    ] }))), { kind: 'hold' });
});

test('Apple relay and ambiguous iCloud delivery remain held because forwarding is not established', async () => {
    for (const recipient of ['parent@privaterelay.appleid.com', 'parent@PRIVATE.ICLOUD.COM', 'parent@icloud.com']) {
        const apple = { ...binding, recipient };
        assert.deepEqual(await observeBrevoInactivityWarning(key, apple, now,
            fake(() => response({ events: [{ ...event, email: recipient }] }))), { kind: 'hold' });
    }
});

test('the event timestamp is rounded forward and cannot land after the trusted clock', async () => {
    const boundary = { ...event, date: '2031-02-01T00:00:00Z' };
    assert.deepEqual(await observeBrevoInactivityWarning(key, binding, now,
        fake(() => response({ events: [boundary] }))), { kind: 'hold' });
    const fractional = { ...event, date: '2031-01-31T23:59:59.1Z' };
    assert.deepEqual(await observeBrevoInactivityWarning(key, binding, now,
        fake(() => response({ events: [fractional] }))), { kind: 'delivered', observedAt: '2031-01-31T23:59:59.200Z' });
});

test('live report shape accepts requests and numeric UTC offsets without treating requests as delivery', async () => {
    // Shape observed during the owner-controlled rehearsal; identifiers are synthetic.
    const request = { ...event, event: 'requests', date: '2031-01-31T20:59:58.377-03:00' };
    const delivered = { ...event, date: '2031-01-31T20:59:59.000-03:00' };
    assert.deepEqual(await observeBrevoInactivityWarning(key, binding, now,
        fake(() => response({ events: [delivered, request] }))),
    { kind: 'delivered', observedAt: '2031-01-31T23:59:59.001Z' });
    assert.deepEqual(await observeBrevoInactivityWarning(key, binding, now,
        fake(() => response({ events: [request] }))), { kind: 'hold' });
    assert.deepEqual(await observeBrevoInactivityWarning(key, binding, now,
        fake(() => response({ events: [delivered, request, { ...delivered, event: 'hardBounce' }] }))), { kind: 'hold' });
});

test('offset dates preserve calendar validation, event bounds and conservative precision', async () => {
    for (const date of ['2031-02-30T20:59:59-03:00', '2031-01-31T23:59:59+14:01',
        '2031-01-31T23:59:59+15:00', '2031-01-31T23:59:59+00:60', '2031-01-31T23:59:59-00:00',
        '2031-01-31T20:59:49-03:00', '2031-01-31T21:00:00-03:00']) {
        assert.deepEqual(await observeBrevoInactivityWarning(key, binding, now,
            fake(() => response({ events: [{ ...event, date }] }))), { kind: 'hold' });
    }
    assert.deepEqual(await observeBrevoInactivityWarning(key, binding, now,
        fake(() => response({ events: [{ ...event, date: '2031-02-01T05:29:59.1+05:30' }] }))),
    { kind: 'delivered', observedAt: '2031-01-31T23:59:59.200Z' });
});
