import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceChildDailyUsage, CHILD_USAGE_LEASE_MS, type ChildDailyUsagePolicy } from './childDailyUsage';

const policy: ChildDailyUsagePolicy = { timeZone: 'America/Sao_Paulo', dailyLimitMs: 60_000 };
const at = (value: string) => Date.parse(value);

test('the daily limit is consumed by elapsed server time and never grants past the remaining allowance', () => {
    const start = at('2026-11-05T15:00:00.000Z');
    const first = advanceChildDailyUsage(null, policy, start, true);
    assert.equal(first.remainingMs, 60_000);
    assert.equal(first.allowedUntilMs, start + CHILD_USAGE_LEASE_MS);
    const second = advanceChildDailyUsage(first.state, policy, start + 25_000, true);
    assert.equal(second.state.usedMs, 25_000);
    assert.equal(second.allowedUntilMs, start + 55_000);
    const third = advanceChildDailyUsage(second.state, policy, start + 50_000, true);
    assert.equal(third.state.usedMs, 50_000);
    assert.equal(third.allowedUntilMs, start + 60_000);
    const blocked = advanceChildDailyUsage(third.state, policy, start + 60_000, true);
    assert.equal(blocked.state.usedMs, 60_000);
    assert.equal(blocked.remainingMs, 0);
    assert.equal(blocked.allowedUntilMs, null);
});

test('overlapping heartbeats count elapsed time once and a parent read preserves the existing lease', () => {
    const start = at('2026-11-05T15:00:00.000Z');
    const first = advanceChildDailyUsage(null, policy, start, true);
    const overlap = advanceChildDailyUsage(first.state, policy, start + 10_000, true);
    const read = advanceChildDailyUsage(overlap.state, policy, start + 15_000, false);
    assert.equal(read.state.usedMs, 15_000);
    assert.equal(read.allowedUntilMs, null);
    assert.equal(read.state.activeUntilMs, start + 40_000);
    const next = advanceChildDailyUsage(read.state, policy, start + 20_000, true);
    assert.equal(next.state.usedMs, 20_000);
});

test('a lost client cannot accumulate more than the last issued lease', () => {
    const start = at('2026-11-05T15:00:00.000Z');
    const first = advanceChildDailyUsage(null, policy, start, true);
    const later = advanceChildDailyUsage(first.state, policy, start + 10 * 60_000, false);
    assert.equal(later.state.usedMs, CHILD_USAGE_LEASE_MS);
    assert.equal(later.state.activeUntilMs, null);
    const resumed = advanceChildDailyUsage(later.state, policy, start + 11 * 60_000, true);
    assert.equal(resumed.state.usedMs, CHILD_USAGE_LEASE_MS);
    assert.equal(resumed.allowedUntilMs, start + 11 * 60_000 + CHILD_USAGE_LEASE_MS);
});

test('a lease crossing midnight counts only the part in the new local day', () => {
    const start = at('2026-11-06T02:59:50.000Z'); // 23:59:50 in São Paulo.
    const prior = { day: '2026-11-05', usedMs: 20_000, accountedAtMs: start, activeUntilMs: start + 30_000 };
    const next = advanceChildDailyUsage(prior, policy, start + 20_000, true);
    assert.equal(next.state.day, '2026-11-06');
    assert.equal(next.state.usedMs, 10_000);
    assert.equal(next.remainingMs, 50_000);
});

test('local day accounting follows daylight-saving changes', () => {
    const eastern = { timeZone: 'America/New_York', dailyLimitMs: 60_000 };
    const start = at('2026-11-01T05:59:50.000Z'); // Fall-back repeats 01:00, not midnight.
    const first = advanceChildDailyUsage(null, eastern, start, true);
    const next = advanceChildDailyUsage(first.state, eastern, start + 20_000, true);
    assert.equal(next.state.day, '2026-11-01');
    assert.equal(next.state.usedMs, 20_000);
});

test('a lower parent-set limit does not erase time already used', () => {
    const start = at('2026-11-05T15:00:00.000Z');
    const higher = { ...policy, dailyLimitMs: 120_000 };
    const first = advanceChildDailyUsage(null, higher, start, true);
    const afterLease = advanceChildDailyUsage(first.state, higher, start + 30_000, true);
    const settled = advanceChildDailyUsage(afterLease.state, higher, start + 55_000, false);
    const lower = advanceChildDailyUsage(settled.state, policy, start + 55_000, true);
    assert.equal(lower.state.usedMs, 55_000);
    assert.equal(lower.allowedUntilMs, start + 60_000);
    const blocked = advanceChildDailyUsage(lower.state, policy, start + 60_000, true);
    assert.equal(blocked.remainingMs, 0);
    assert.equal(blocked.allowedUntilMs, null);
});

test('a stale lease from a prior local day does not carry usage into a later day', () => {
    const start = at('2026-11-05T15:00:00.000Z');
    const first = advanceChildDailyUsage(null, policy, start, true);
    const nextDay = advanceChildDailyUsage(first.state, policy, start + 24 * 60 * 60_000, false);
    assert.equal(nextDay.state.day, '2026-11-06');
    assert.equal(nextDay.state.usedMs, 0);
    assert.equal(nextDay.state.activeUntilMs, null);
});

test('invalid policies, inconsistent state and clocks moving backward are rejected', () => {
    const start = at('2026-11-05T15:00:00.000Z');
    const first = advanceChildDailyUsage(null, policy, start, true);
    assert.throws(() => advanceChildDailyUsage(first.state, policy, start - 1, true));
    assert.throws(() => advanceChildDailyUsage(first.state, { ...policy, timeZone: 'not/a-zone' }, start, true));
    assert.throws(() => advanceChildDailyUsage(first.state, { ...policy, dailyLimitMs: 0 }, start, true));
    assert.throws(() => advanceChildDailyUsage({ ...first.state, day: '2026-01-01' }, policy, start, true));
    assert.throws(() => advanceChildDailyUsage({ ...first.state, activeUntilMs: start + 30_001 }, policy, start, true));
});
