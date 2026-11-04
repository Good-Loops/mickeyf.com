import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { verifyDeliverySignature, verifyInactivityDeliveryEvent, type ExpectedDelivery } from './inactivityDeliveryEvent';

const key = Buffer.alloc(32, 9);
const secret = `whsec_${key.toString('base64')}`;
const now = Date.parse('2031-01-05T12:00:00.000Z');
const expected: ExpectedDelivery = { providerEmailId: '782ed45a-c57d-4c82-9b50-d4585331bcec',
    recipient: 'synthetic-parent@example.test', from: 'Ludolume <notices@example.test>', notBeforeMs: now - 1000 };
const event = { type: 'email.delivered', created_at: '2031-01-05T11:59:59.500Z', data: {
    email_id: expected.providerEmailId, from: expected.from, to: [expected.recipient],
} };
function signed(value: unknown = event, seconds = Math.floor(now / 1000)) {
    const body = Buffer.from(JSON.stringify(value));
    const id = 'msg_synthetic';
    const timestamp = String(seconds);
    const mac = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest('base64');
    return { body, headers: { id, timestamp, signature: `v1,${mac}` } };
}
function check(value: ReturnType<typeof signed>, binding = expected, time = now) {
    return verifyInactivityDeliveryEvent(value.body, value.headers, secret, binding, time);
}

test('verifies the published Svix signature example without relying on a locally generated signature', () => {
    const payload = Buffer.from('{"event_type":"ping","data":{"success":true}}');
    const headers = { id: 'msg_loFOjxBNrRLzqYUf', timestamp: '1731705121',
        signature: 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=' };
    const publishedExampleSecret = 'whsec_plJ3nmyCDGBKInavdOK15jsl';
    assert.equal(verifyDeliverySignature(payload, headers, publishedExampleSecret, 1731705121000), true);
    assert.equal(verifyDeliverySignature(Buffer.from(`${payload.toString()} `), headers, publishedExampleSecret, 1731705121000), false);
});

test('accepts a signed delivery event only for the exact expected message and recipient', () => {
    assert.deepEqual(check(signed()), { eventId: 'msg_synthetic', providerEmailId: expected.providerEmailId,
        observedAt: '2031-01-05T11:59:59.500000Z', recipientRoute: 'direct' });
    assert.equal(check(signed({ ...event, type: 'email.sent' })), null);
    assert.equal(check(signed({ ...event, type: 'email.bounced' })), null);
    assert.equal(check(signed({ ...event, data: { ...event.data, to: ['other@example.test'] } })), null);
    assert.equal(check(signed({ ...event, data: { ...event.data, to: [expected.recipient, 'other@example.test'] } })), null);
    assert.equal(check(signed({ ...event, data: { ...event.data, from: 'other@example.test' } })), null);
    assert.equal(check(signed({ ...event, data: { ...event.data, email_id: '882ed45a-c57d-4c82-9b50-d4585331bcec' } })), null);
});

test('distinguishes delivery to an Apple relay from delivery to a direct address', () => {
    const relay = 'synthetic@privaterelay.appleid.com';
    const binding = { ...expected, recipient: relay };
    const notice = { ...event, data: { ...event.data, to: [relay] } };
    assert.equal(check(signed(notice), binding)?.recipientRoute, 'apple-relay');
});

test('rejects altered bodies, invalid signatures, stale timestamps, and invalid secrets', () => {
    const valid = signed();
    assert.equal(check({ ...valid, body: Buffer.from(`${valid.body.toString()} `) }), null);
    assert.equal(check({ ...valid, headers: { ...valid.headers, signature: `v1,${Buffer.alloc(32).toString('base64')}` } }), null);
    assert.equal(check(signed(event, Math.floor(now / 1000) - 301)), null);
    assert.equal(check(signed(event, Math.floor(now / 1000) + 301)), null);
    assert.equal(verifyInactivityDeliveryEvent(valid.body, valid.headers, 'whsec_invalid', expected, now), null);
    assert.equal(verifyInactivityDeliveryEvent(Buffer.alloc(65537), valid.headers, secret, expected, now), null);
    assert.ok(check({ ...valid, headers: { ...valid.headers, signature: `v2,ignore ${valid.headers.signature}` } }));
});

test('holds when the event predates its send attempt or is future dated', () => {
    assert.equal(check(signed(), { ...expected, notBeforeMs: now }), null);
    assert.equal(check(signed({ ...event, created_at: '2031-01-05T12:00:00.001Z' })), null);
    assert.equal(check(signed({ ...event, created_at: '2031-02-30T12:00:00.000Z' })), null);
    assert.equal(check(signed({ ...event, created_at: '2031-01-05T12:00:00.000001Z' })), null);
    assert.equal(check(signed({ ...event, created_at: '2031-01-05T12:00:00+14:01' })), null);
});

test('preserves provider subsecond precision and normalizes UTC offsets without starting a deadline early', () => {
    const precise = check(signed({ ...event, created_at: '2031-01-05T08:59:59.5001234-03:00' }));
    assert.equal(precise?.observedAt, '2031-01-05T11:59:59.500124Z');
    const rollover = check(signed({ ...event, created_at: '2031-01-05T11:59:59.9999999Z' }));
    assert.equal(rollover?.observedAt, '2031-01-05T12:00:00.000000Z');
});
