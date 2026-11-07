import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAccountId, isAccountId, parseDeletionIntent } from './deletionJournal';

const ACCOUNT_ID = '42a23d28-40cf-4d69-9fdb-74206ef3fa70';
const INTENT = {
    version: 1, accountId: ACCOUNT_ID, action: 'delete-account', requestedAt: '2026-09-11T12:00:00.000Z',
};

test('stable account identity accepts only lowercase version 1 or 4 UUIDs', () => {
    assert.equal(isAccountId(ACCOUNT_ID), true);
    assert.equal(isAccountId('42a23d28-40cf-1d69-9fdb-74206ef3fa70'), true);
    for (const value of [1, '', ACCOUNT_ID.toUpperCase(), ACCOUNT_ID.replace('-4d69-', '-7d69-'),
        ACCOUNT_ID.replace('-9fdb-', '-1fdb-'), `${ACCOUNT_ID} `]) {
        assert.equal(isAccountId(value), false);
        assert.throws(() => assertAccountId(value), /Invalid stable account identity/);
    }
});

test('deletion intent is a minimal copied record, not a passthrough object', () => {
    const parsed = parseDeletionIntent(INTENT);
    assert.deepEqual(parsed, INTENT);
    assert.notEqual(parsed, INTENT);
});

test('deletion intent rejects unknown actions, versions, PII and invalid timestamps', () => {
    for (const value of [null, [], 'record', { ...INTENT, version: 2 },
        { ...INTENT, action: 'withdraw-consent' }, { ...INTENT, email: 'private@example.test' },
        { ...INTENT, userId: 123 }, { ...INTENT, accountId: 123 },
        { ...INTENT, requestedAt: '2026-09-11T12:00:00Z' },
        { ...INTENT, requestedAt: '2026-02-30T12:00:00.000Z' },
        { ...INTENT, requestedAt: '2026-09-11T12:00:00.000+00:00' }]) {
        assert.throws(() => parseDeletionIntent(value), /Invalid deletion intent/);
    }
});
