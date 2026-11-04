import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import type { VerifiedAppleNotification } from '../auth/appleNotificationVerifier';
import { cleanupParentFormAppleRelayState, recordParentFormAppleRelayEvent } from './parentFormAppleRelayState';

const notification = { audience: 'com.example.app', subject: 'opaque-subject', eventType: 'email-disabled',
    issuedAt: 1_800_000_000, eventTime: 1_799_999_999, relayEmail: 'parent@privaterelay.appleid.com' } as VerifiedAppleNotification;

test('binds a verified forwarding change to the exact subject, contact, event and existing request', async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const database = { async query(options: { sql: string; timeout: number }, values: unknown[]) {
        assert.equal(options.timeout, 10_000); calls.push({ sql: options.sql, values }); return [{ affectedRows: 1 }, []];
    } } as unknown as Pick<Pool, 'query'>;
    await recordParentFormAppleRelayEvent(database, notification);
    assert.deepEqual(calls[0].values, [notification.eventTime, 1, Buffer.from(notification.subject),
        notification.relayEmail, notification.eventTime + 1]);
    assert.match(calls[0].sql, /f\.subject=\? AND BINARY f\.verified_contact=BINARY \?/u);
    assert.match(calls[0].sql, /GREATEST\(forwarding_disabled,VALUES\(forwarding_disabled\)\)/u);
    assert.match(calls[0].sql, /f\.submitted_at<TIMESTAMPADD\(SECOND, \?, '1970-01-01 00:00:00'\)/u);
    await recordParentFormAppleRelayEvent(database, { ...notification, eventType: 'email-enabled' });
    assert.equal(calls[1].values[1], 0);
});

test('missing or malformed forwarding details do not change state', async () => {
    let calls = 0;
    const database = { async query() { calls++; return [{ affectedRows: 1 }, []]; } } as unknown as Pick<Pool, 'query'>;
    for (const change of [{ relayEmail: undefined }, { relayEmail: 'bad' }, { relayEmail: 'A@example.test' },
        { subject: 'bad\nsubject' }, { eventTime: 0 }, { eventType: 'consent-revoked' }]) {
        await assert.rejects(recordParentFormAppleRelayEvent(database, { ...notification, ...change } as VerifiedAppleNotification));
    }
    assert.equal(calls, 0);
});

test('a database failure never masquerades as recorded state', async () => {
    const database = { async query() { throw new Error('database unavailable'); } } as unknown as Pick<Pool, 'query'>;
    await assert.rejects(recordParentFormAppleRelayEvent(database, notification));
});

test('bounded cleanup reports a possibly remaining backlog without exposing account data', async () => {
    let affectedRows = 100;
    const database = { async query(options: { sql: string; timeout: number }) {
        assert.match(options.sql, /status IN \('used','rejected'\) OR expires_at<=UTC_TIMESTAMP\(6\)/u);
        assert.match(options.sql, /LIMIT 100/u);
        return [{ affectedRows }, []];
    } } as unknown as Pick<Pool, 'query'>;
    assert.deepEqual(await cleanupParentFormAppleRelayState(database), { backlog: true });
    affectedRows = 3;
    assert.deepEqual(await cleanupParentFormAppleRelayState(database), { backlog: false });
    affectedRows = 101;
    await assert.rejects(cleanupParentFormAppleRelayState(database));
});
