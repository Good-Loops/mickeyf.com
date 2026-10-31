import assert from 'node:assert/strict';
import test from 'node:test';
import { assessChildInactivity, INACTIVITY_NOTICE_DIGEST, type InactivitySnapshot } from './childInactivityPolicy';

const parentId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const warningId = '33333333-3333-4333-8333-333333333333';
const activityAt = '2028-01-01T00:00:00.000000Z';
const contactDigest = 'a'.repeat(64);
const deliveredAt = '2030-12-02T00:00:00.000000Z';
const warning = { parentId, childId, warningId, activityAt, contactDigest, noticeDigest: INACTIVITY_NOTICE_DIGEST, deliveredAt, receiptDigest: 'b'.repeat(64) };
const snapshot: InactivitySnapshot = { parentId, childId, activityAt, activityComplete: true,
    currentContactDigest: contactDigest, contactVerified: true, warning: null };
const at = (iso: string) => Date.parse(iso);

test('warning starts no earlier than 30 days before three calendar years', () => {
    assert.equal(assessChildInactivity(snapshot, at('2030-12-01T23:59:59.999Z')), 'hold');
    assert.equal(assessChildInactivity(snapshot, at('2030-12-02T00:00:00.000Z')), 'warning-due');
    assert.equal(assessChildInactivity({ ...snapshot, warning }, at('2030-12-31T23:59:59.999Z')), 'grace');
    assert.equal(assessChildInactivity({ ...snapshot, warning }, at('2031-01-01T00:00:00.000Z')), 'eligible');
});

test('late delivery extends the deadline to at least 30 full days', () => {
    const late = { ...warning, deliveredAt: '2031-01-10T00:00:00.000000Z' };
    assert.equal(assessChildInactivity({ ...snapshot, warning: late }, at('2031-02-08T23:59:59.999Z')), 'grace');
    assert.equal(assessChildInactivity({ ...snapshot, warning: late }, at('2031-02-09T00:00:00.000Z')), 'eligible');
});

test('changed activity, parent, child, contact or receipt invalidates the warning', () => {
    const now = at('2032-01-01T00:00:00.000Z');
    for (const next of [
        { ...snapshot, activityAt: '2028-01-01T00:00:00.000001Z', warning },
        { ...snapshot, warning: { ...warning, parentId: childId } },
        { ...snapshot, warning: { ...warning, childId: parentId } },
        { ...snapshot, currentContactDigest: 'c'.repeat(64), warning },
        { ...snapshot, warning: { ...warning, receiptDigest: '' } },
        { ...snapshot, warning: { ...warning, noticeDigest: 'd'.repeat(64) } },
        { ...snapshot, warning: { ...warning, deliveredAt: '2033-01-01T00:00:00.000000Z' } },
        { ...snapshot, warning: { ...warning, deliveredAt: '2030-12-01T00:00:00.000000Z' } },
    ]) assert.equal(assessChildInactivity(next, now), 'await-confirmed-warning');
});

test('unknown, unhealthy, malformed or future evidence always holds', () => {
    const now = at('2031-01-01T00:00:00.000Z');
    for (const next of [
        { ...snapshot, activityAt: null }, { ...snapshot, activityComplete: false },
        { ...snapshot, currentContactDigest: null }, { ...snapshot, contactVerified: false },
        { ...snapshot, activityAt: '2028-02-30T00:00:00.000000Z' },
        { ...snapshot, activityAt: '2032-01-01T00:00:00.000000Z' },
        { ...snapshot, parentId: childId },
    ]) assert.equal(assessChildInactivity(next, now), 'hold');
    assert.equal(assessChildInactivity(snapshot, Number.NaN), 'hold');
});

test('leap-day anniversaries roll forward and submillisecond timestamps never delete early', () => {
    const leap = { ...snapshot, activityAt: '2028-02-29T12:00:00.000001Z' };
    const receipt = { ...warning, activityAt: leap.activityAt, deliveredAt: '2031-01-30T12:00:00.001000Z' };
    assert.equal(assessChildInactivity({ ...leap, warning: receipt }, at('2031-03-01T12:00:00.000Z')), 'grace');
    assert.equal(assessChildInactivity({ ...leap, warning: receipt }, at('2031-03-01T12:00:00.001Z')), 'eligible');
});
