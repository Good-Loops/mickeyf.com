import assert from 'node:assert/strict';
import test from 'node:test';
import type { InactivitySnapshot } from '../accounts/childInactivityPolicy';
import { assessNonresponseCandidate, NONRESPONSE_NOTICE_DIGEST, type AcceptedOutreach } from './childInactivityNonresponsePolicy';

const parentId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const warningId = '33333333-3333-4333-8333-333333333333';
const activityAt = '2028-01-01T00:00:00.000000Z';
const targetDigest = 'a'.repeat(64);
const acceptanceDigest = 'b'.repeat(64);
const deliveryDigest = 'e'.repeat(64);
const snapshot: InactivitySnapshot = { parentId, childId, activityAt, activityComplete: true,
    channel: 'email', targetVerified: true, currentTargetDigest: targetDigest, warning: null };
const outreach: AcceptedOutreach = { parentId, childId, activityAt, targetDigest, warningId, channel: 'email',
    noticeDigest: NONRESPONSE_NOTICE_DIGEST, acceptedAt: '2030-12-02T00:00:00.000000Z', acceptanceDigest,
    deliveredAt: '2030-12-02T00:00:00.000000Z', deliveryDigest };
const verified = (value: AcceptedOutreach) => value.acceptanceDigest === acceptanceDigest && value.deliveryDigest === deliveryDigest;
const at = (iso: string) => Date.parse(iso);

test('no-response candidate waits twelve months beyond the later of three years or the warning period', () => {
    assert.equal(assessNonresponseCandidate(snapshot, outreach, 'not-acknowledged', at('2031-12-31T23:59:59.999Z'), verified), 'waiting');
    assert.equal(assessNonresponseCandidate(snapshot, outreach, 'not-acknowledged', at('2032-01-01T00:00:00.000Z'), verified), 'candidate');
    const late = { ...outreach, acceptedAt: '2032-04-10T00:00:00.000000Z', deliveredAt: '2032-04-10T00:00:00.000000Z' };
    assert.equal(assessNonresponseCandidate(snapshot, late, 'not-acknowledged', at('2033-05-09T23:59:59.999Z'), verified), 'waiting');
    assert.equal(assessNonresponseCandidate(snapshot, late, 'not-acknowledged', at('2033-05-10T00:00:00.000Z'), verified), 'candidate');
});

test('a queued warning starts its response window at delivery, not acceptance', () => {
    const queued = { ...outreach, acceptedAt: '2032-04-10T00:00:00.000000Z', deliveredAt: '2032-04-17T00:00:00.000001Z' };
    assert.equal(assessNonresponseCandidate(snapshot, queued, 'not-acknowledged', at('2033-05-17T00:00:00.000Z'), verified), 'waiting');
    assert.equal(assessNonresponseCandidate(snapshot, queued, 'not-acknowledged', at('2033-05-17T00:00:00.001Z'), verified), 'candidate');
});

test('missing or unverifiable outreach never becomes a deletion candidate', () => {
    const now = at('2035-01-01T00:00:00.000Z');
    assert.equal(assessNonresponseCandidate(snapshot, null, 'not-acknowledged', at('2030-12-01T23:59:59.999Z'), verified), 'hold');
    assert.equal(assessNonresponseCandidate(snapshot, null, 'not-acknowledged', at('2030-12-02T00:00:00.000Z'), verified), 'warning-due');
    assert.equal(assessNonresponseCandidate(snapshot, null, 'not-acknowledged', now, verified), 'warning-due');
    assert.equal(assessNonresponseCandidate(snapshot, outreach, 'not-acknowledged', now, () => false), 'hold');
    assert.equal(assessNonresponseCandidate(snapshot, outreach, 'not-acknowledged', now, () => { throw new Error('unknown provider state'); }), 'hold');
    assert.equal(assessNonresponseCandidate(snapshot, outreach, 'unknown', now, verified), 'hold');
    assert.equal(assessNonresponseCandidate(snapshot, outreach, 'acknowledged', now, verified), 'hold');
});

test('a provider-reported delivery needs no read receipt but a confirmed warning uses its separate workflow', () => {
    const now = at('2035-01-01T00:00:00.000Z');
    let calls = 0;
    const verifyProviderDelivery = (value: AcceptedOutreach) => { calls++; return verified(value); };
    assert.equal(assessNonresponseCandidate(snapshot, outreach, 'not-acknowledged', now, verifyProviderDelivery), 'candidate');
    assert.equal(calls, 1);
    const confirmed = { ...snapshot, warning: { ...outreach, deliveredAt: outreach.acceptedAt, receiptDigest: 'c'.repeat(64) } };
    assert.equal(assessNonresponseCandidate(confirmed, outreach, 'not-acknowledged', now, verifyProviderDelivery), 'hold');
    assert.equal(calls, 1);
});

test('changed target, relationship, activity, notice, or invalid acceptance holds', () => {
    const now = at('2035-01-01T00:00:00.000Z');
    for (const changed of [
        { ...outreach, parentId: childId }, { ...outreach, childId: parentId },
        { ...outreach, activityAt: '2028-01-01T00:00:00.000001Z' }, { ...outreach, targetDigest: 'c'.repeat(64) },
        { ...outreach, warningId: 'bad' }, { ...outreach, noticeDigest: 'd'.repeat(64) },
        { ...outreach, acceptanceDigest: '' }, { ...outreach, acceptedAt: '2030-12-01T23:59:59.999999Z' },
        { ...outreach, acceptedAt: '2036-01-01T00:00:00.000000Z' },
        { ...outreach, deliveryDigest: '' }, { ...outreach, deliveredAt: '' },
        { ...outreach, deliveredAt: '2030-12-01T23:59:59.999999Z' },
        { ...outreach, deliveredAt: '2036-01-01T00:00:00.000000Z' },
    ]) assert.equal(assessNonresponseCandidate(snapshot, changed, 'not-acknowledged', now, verified), 'hold');
    for (const changed of [{ ...snapshot, activityAt: null }, { ...snapshot, activityComplete: false },
        { ...snapshot, targetVerified: false }, { ...snapshot, currentTargetDigest: null },
        { ...snapshot, channel: 'in-app' as const }]) {
        assert.equal(assessNonresponseCandidate(changed, outreach, 'not-acknowledged', now, verified), 'hold');
    }
});

test('four-year and outreach anniversaries round leap days forward and preserve microsecond safety', () => {
    const leap = { ...snapshot, activityAt: '2028-02-29T12:00:00.000001Z' };
    const accepted = { ...outreach, activityAt: leap.activityAt, acceptedAt: '2031-01-30T12:00:00.001000Z', deliveredAt: '2031-01-30T12:00:00.001000Z' };
    assert.equal(assessNonresponseCandidate(leap, accepted, 'not-acknowledged', at('2032-03-01T12:00:00.000Z'), verified), 'waiting');
    assert.equal(assessNonresponseCandidate(leap, accepted, 'not-acknowledged', at('2032-03-01T12:00:00.001Z'), verified), 'candidate');
    const leapOutreach = { ...outreach, acceptedAt: '2032-02-29T12:00:00.000000Z', deliveredAt: '2032-02-29T12:00:00.000000Z' };
    assert.equal(assessNonresponseCandidate(snapshot, leapOutreach, 'not-acknowledged', at('2033-03-30T11:59:59.999Z'), verified), 'waiting');
    assert.equal(assessNonresponseCandidate(snapshot, leapOutreach, 'not-acknowledged', at('2033-03-30T12:00:00.000Z'), verified), 'candidate');
});
