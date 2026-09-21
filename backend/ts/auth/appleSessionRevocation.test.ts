import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolConnection, QueryOptions } from 'mysql2/promise';
import type { VerifiedAppleNotification } from './appleNotificationVerifier';
import { applyAppleNotification, appleSubjectHash, assertFreshAppleSession,
    cleanupExpiredAppleRevocations, AppleSessionRevocationUnavailableError, type AppleSessionProof } from './appleSessionRevocation';

const NOW = 1_800_000_000;
const accountId = randomUUID();
const proof: AppleSessionProof = { clientId: 'com.example.app', subject: 'apple-subject', issuedAt: NOW - 5 };
const hash = appleSubjectHash(proof);
const notification = (overrides: Partial<VerifiedAppleNotification> = {}) => ({
    audience: proof.clientId, subject: proof.subject, issuedAt: NOW,
    eventType: 'consent-revoked', eventTime: NOW, ...overrides,
}) as VerifiedAppleNotification;
type Session = { accountId: string; hash: Buffer | null; authenticatedAt: number | null };
type Account = { userId: number; accountId: string; subject: Buffer };
type Call = { sql: string; values: unknown[]; connection: number };

function fixture(options: {
    accounts?: Account[]; fail?: (call: Call) => boolean; count?: unknown; now?: number;
    lockResult?: number | null; onCall?: (call: Call) => void | Promise<void>;
} = {}) {
    const calls: Call[] = [];
    const watermarks = new Map<string, { revokedAt: number; expiresAt: number }>();
    const sessions: Session[] = [];
    const accounts = options.accounts ?? [{ userId: 7, accountId, subject: Buffer.from(proof.subject) }];
    const released: number[] = []; const destroyed: number[] = [];
    let now = options.now ?? NOW; let connectionId = 0;
    function connection(id: number) {
        return {
            async query(query: QueryOptions, values: unknown[] = []) {
                assert.equal(query.timeout, 10_000);
                const sql = query.sql;
                const call = { sql, values, connection: id }; calls.push(call);
                await options.onCall?.(call);
                if (options.fail?.(call)) throw new Error('private raw JWS, subject, token and SQL details');
                if (sql.includes('GET_LOCK')) return [[{ lockResult: options.lockResult === undefined ? 1 : options.lockResult }], []];
                if (sql.includes('RELEASE_LOCK')) return [[{ lockResult: 1 }], []];
                if (sql.startsWith('SELECT TIMESTAMPDIFF')) return [[{ now }], []];
                if (sql.startsWith('SELECT subject FROM account_provider_identities')) {
                    return [accounts.filter(account => account.accountId === values[0]).map(({ subject }) => ({ subject })), []];
                }
                if (sql.startsWith('SELECT revoked_at')) {
                    const stored = watermarks.get((values[0] as Buffer).toString('hex'));
                    return [stored ? [{ revoked_at: stored.revokedAt }] : [], []];
                }
                if (sql.startsWith('SELECT COUNT(*)')) return [[{ watermarkCount: options.count ?? watermarks.size }], []];
                if (sql.startsWith('INSERT INTO apple_auth_revocations')) {
                    const key = (values[0] as Buffer).toString('hex'); const prior = watermarks.get(key);
                    watermarks.set(key, { revokedAt: Math.max(prior?.revokedAt ?? 0, values[1] as number),
                        expiresAt: Math.max(prior?.expiresAt ?? 0, values[2] as number) });
                    return [{ affectedRows: prior ? 2 : 1 }, []];
                }
                if (sql.startsWith('DELETE FROM apple_auth_revocations')) {
                    let deleted = 0;
                    for (const [key, value] of watermarks) {
                        if (value.expiresAt <= now && deleted < 100) { watermarks.delete(key); deleted++; }
                    }
                    return [{ affectedRows: deleted }, []];
                }
                if (sql.startsWith('SELECT u.user_id')) {
                    return [accounts.filter(account => account.subject.equals(values[0] as Buffer))
                        .map(({ userId, accountId: id }) => ({ userId, accountId: id })), []];
                }
                if (sql.startsWith('SELECT u.account_uuid')) {
                    return [accounts.filter(account => account.userId === values[0])
                        .map(({ accountId: id, subject }) => ({ accountId: id, subject })), []];
                }
                if (sql.startsWith('DELETE FROM account_sessions')) {
                    let deleted = 0;
                    for (let index = sessions.length - 1; index >= 0; index--) {
                        const session = sessions[index];
                        if (session.accountId === values[0] && session.hash?.equals(values[1] as Buffer)
                            && session.authenticatedAt !== null && session.authenticatedAt <= Number(values[2])) {
                            sessions.splice(index, 1); deleted++;
                        }
                    }
                    return [{ affectedRows: deleted }, []];
                }
                if (['START TRANSACTION', 'COMMIT', 'ROLLBACK'].includes(sql)) return [{ affectedRows: 0 }, []];
                throw new Error(`Unexpected fixture SQL: ${sql}`);
            },
            release() { released.push(id); }, destroy() { destroyed.push(id); },
        } as unknown as PoolConnection;
    }
    const database = { query: connection(0).query, getConnection: async () => connection(++connectionId) } as Pick<Pool, 'query' | 'getConnection'>;
    return { database, reader: connection(-1), calls, watermarks, sessions, accounts, released, destroyed,
        setNow(value: number) { now = value; } };
}

test('subject hashes bind exact client and subject with collision-safe framing', () => {
    assert.equal(hash.length, 32);
    assert.deepEqual(appleSubjectHash({ ...proof }), hash);
    assert.notDeepEqual(appleSubjectHash({ ...proof, clientId: 'other.app' }), hash);
    assert.notDeepEqual(appleSubjectHash({ ...proof, subject: 'Apple-subject' }), hash);
    assert.notDeepEqual(appleSubjectHash({ clientId: 'ab', subject: 'c' }), appleSubjectHash({ clientId: 'a', subject: 'bc' }));
    for (const invalid of ['', 'space here', '\n', 'é', 'x'.repeat(256)]) {
        assert.throws(() => appleSubjectHash({ clientId: invalid, subject: proof.subject }), TypeError);
        assert.throws(() => appleSubjectHash({ clientId: proof.clientId, subject: invalid }), TypeError);
    }
});

test('final issuance uses locked exact linkage, watermark and database clock after all lock waits', async () => {
    const f = fixture();
    assert.equal(await assertFreshAppleSession(f.reader, accountId, proof), true);
    assert.deepEqual(f.calls[0].values, [accountId]);
    assert.match(f.calls[0].sql, /FOR SHARE/u);
    assert.deepEqual(f.calls[1].values, [hash]);
    assert.match(f.calls[1].sql, /FOR SHARE/u);
    assert.match(f.calls.at(-1)!.sql, /UTC_TIMESTAMP/u);
    assert(f.calls.every(call => call.sql.startsWith('SELECT')));
    const waiting = fixture({ onCall(call) { if (call.sql.startsWith('SELECT revoked_at')) waiting.setNow(NOW + 295); } });
    assert.equal(await assertFreshAppleSession(waiting.reader, accountId, proof), false);
});

test('proof age, future tolerance, exact linkage and inclusive watermark cutoff fail closed', async () => {
    for (const [issuedAt, expected] of [[NOW - 299, true], [NOW - 300, false], [NOW + 30, true], [NOW + 31, false]] as const) {
        assert.equal(await assertFreshAppleSession(fixture().reader, accountId, { ...proof, issuedAt }), expected);
    }
    assert.equal(await assertFreshAppleSession(fixture({ accounts: [] }).reader, accountId, proof), false);
    assert.equal(await assertFreshAppleSession(fixture().reader, randomUUID(), proof), false);
    assert.equal(await assertFreshAppleSession(fixture().reader, accountId, { ...proof, subject: 'not-linked' }), false);
    const f = fixture();
    f.watermarks.set(hash.toString('hex'), { revokedAt: proof.issuedAt, expiresAt: NOW + 330 });
    assert.equal(await assertFreshAppleSession(f.reader, accountId, proof), false);
    assert.equal(await assertFreshAppleSession(f.reader, accountId, { ...proof, issuedAt: proof.issuedAt + 1 }), true);
    await assert.rejects(assertFreshAppleSession(f.reader, accountId, { ...proof, issuedAt: NaN }), TypeError);
});

test('notifications first commit bounded watermark then revoke only older Apple-issued sessions', async () => {
    const f = fixture();
    const password = { accountId, hash: null, authenticatedAt: null };
    const google = { accountId, hash: null, authenticatedAt: null };
    const newer = { accountId, hash, authenticatedAt: NOW + 1 };
    const otherClient = { accountId, hash: appleSubjectHash({ ...proof, clientId: 'other.app' }), authenticatedAt: NOW - 5 };
    const otherAccount = { accountId: randomUUID(), hash, authenticatedAt: NOW - 5 };
    f.sessions.push({ accountId, hash, authenticatedAt: NOW - 1 }, { accountId, hash, authenticatedAt: NOW },
        password, google, newer, otherClient, otherAccount);
    await applyAppleNotification(f.database, notification());
    assert.deepEqual(f.sessions, [password, google, newer, otherClient, otherAccount]);
    assert.deepEqual(f.watermarks.get(hash.toString('hex')), { revokedAt: NOW, expiresAt: NOW + 330 });
    const commit = f.calls.findIndex(call => call.connection === 1 && call.sql === 'COMMIT');
    const lookup = f.calls.findIndex(call => call.sql.startsWith('SELECT u.user_id'));
    const userLock = f.calls.findIndex(call => call.sql.includes('GET_LOCK') && call.connection === 2);
    assert(commit >= 0 && commit < lookup && lookup < userLock);
    assert.match(f.calls.find(call => call.sql.startsWith('SELECT u.account_uuid'))!.sql, /FOR UPDATE/u);
    assert.equal(f.calls.some(call => /DELETE FROM (users|account_provider_identities|apple_provider_tokens|game_)/u.test(call.sql)), false);
    assert.deepEqual(f.destroyed, []);
    assert.deepEqual(f.released, [1, 2]);
});

test('unknown-subject event before signup or recreation blocks still-fresh pre-event proof', async () => {
    const f = fixture({ accounts: [] });
    await applyAppleNotification(f.database, notification());
    assert.equal(f.watermarks.size, 1);
    const createdId = randomUUID();
    f.accounts.push({ userId: 9, accountId: createdId, subject: Buffer.from(proof.subject) });
    assert.equal(await assertFreshAppleSession(f.reader, createdId, proof), false);
    assert.equal(await assertFreshAppleSession(f.reader, createdId, { ...proof, issuedAt: NOW + 1 }), true);
});

test('duplicate and out-of-order events neither reduce the cutoff nor extend retention from receipt time', async () => {
    const f = fixture();
    await applyAppleNotification(f.database, notification());
    f.setNow(NOW + 20);
    await applyAppleNotification(f.database, notification());
    await applyAppleNotification(f.database, notification({ eventTime: NOW - 10 }));
    assert.deepEqual(f.watermarks.get(hash.toString('hex')), { revokedAt: NOW, expiresAt: NOW + 330 });
    assert.match(f.calls.find(call => call.sql.startsWith('INSERT INTO apple_auth_revocations'))!.sql, /GREATEST/u);
});

test('old events still revoke pre-event sessions without retaining an expired watermark', async () => {
    const f = fixture(); const eventTime = NOW - 1_000;
    const newer = { accountId, hash, authenticatedAt: NOW - 5 };
    f.sessions.push({ accountId, hash, authenticatedAt: eventTime }, newer);
    await applyAppleNotification(f.database, notification({ eventTime }));
    assert.deepEqual(f.sessions, [newer]);
    assert.equal(f.watermarks.size, 0);
    assert.equal(f.calls.some(call => call.sql.startsWith('INSERT')), false);
});

test('session issued before watermark insertion is covered by post-commit account lookup', async () => {
    const f = fixture({ onCall(call) {
        if (call.sql.startsWith('INSERT INTO apple_auth_revocations')) {
            f.sessions.push({ accountId, hash, authenticatedAt: proof.issuedAt });
        }
    } });
    assert.equal(await assertFreshAppleSession(f.reader, accountId, proof), true);
    await applyAppleNotification(f.database, notification());
    assert.equal(f.sessions.length, 0);
});

test('deletion or recreation while waiting on user lock never targets the new incarnation', async () => {
    for (const replacement of [undefined, randomUUID()]) {
        const f = fixture({ onCall(call) {
            if (call.sql.includes('GET_LOCK') && call.connection === 2) {
                f.accounts.splice(0);
                if (replacement) f.accounts.push({ userId: 7, accountId: replacement, subject: Buffer.from(proof.subject) });
            }
        } });
        await applyAppleNotification(f.database, notification());
        assert.equal(f.calls.some(call => call.sql.startsWith('DELETE FROM account_sessions')), false);
        assert.equal(f.watermarks.size, 1);
    }
});

test('email changes are authenticated no-ops; account-deleted only revokes Apple sessions', async () => {
    for (const eventType of ['email-enabled', 'email-disabled'] as const) {
        const f = fixture(); await applyAppleNotification(f.database, notification({ eventType }));
        assert.equal(f.calls.length, 0);
    }
    const f = fixture(); f.sessions.push({ accountId, hash, authenticatedAt: NOW });
    await applyAppleNotification(f.database, notification({ eventType: 'account-deleted' }));
    assert.equal(f.sessions.length, 0);
    assert.equal(f.accounts.length, 1);
});

test('bounded global capacity allows updates but refuses new subject growth and cleans only expiry batch', async () => {
    const full = fixture({ count: 10_000 });
    await assert.rejects(applyAppleNotification(full.database, notification()), AppleSessionRevocationUnavailableError);
    assert.equal(full.calls.some(call => call.sql.startsWith('INSERT')), false);
    assert.equal(full.calls.some(call => call.sql.startsWith('SELECT u.user_id')), false);
    full.watermarks.set(hash.toString('hex'), { revokedAt: NOW - 1, expiresAt: NOW + 329 });
    await applyAppleNotification(full.database, notification());
    assert.equal(full.watermarks.get(hash.toString('hex'))!.revokedAt, NOW);
    const f = fixture();
    for (let index = 0; index < 101; index++) f.watermarks.set(String(index), { revokedAt: NOW - 400, expiresAt: NOW - 1 });
    assert.equal(await cleanupExpiredAppleRevocations(f.reader), 100);
    assert.equal(f.watermarks.size, 1);
    assert.match(f.calls[0].sql, /ORDER BY expires_at LIMIT 100/u);
});

test('phase-two failures retain the committed watermark and expose no driver details', async () => {
    const f = fixture({ fail: call => call.sql.startsWith('DELETE FROM account_sessions') });
    await assert.rejects(applyAppleNotification(f.database, notification()), error => {
        assert(error instanceof AppleSessionRevocationUnavailableError);
        assert.equal('cause' in error, false);
        assert.doesNotMatch(String(error), /private|JWS|subject|SQL/u);
        return true;
    });
    assert.equal(f.watermarks.size, 1);
    assert(f.calls.some(call => call.connection === 2 && call.sql === 'ROLLBACK'));
    assert.equal(await assertFreshAppleSession(f.reader, accountId, proof), false);
});

test('uncertain commits and lock responses destroy connections; failures cannot acknowledge processing', async () => {
    for (const connectionId of [1, 2]) {
        const f = fixture({ fail: call => call.connection === connectionId && call.sql === 'COMMIT' });
        await assert.rejects(applyAppleNotification(f.database, notification()), AppleSessionRevocationUnavailableError);
        assert(f.destroyed.includes(connectionId));
        assert(!f.released.includes(connectionId));
    }
    const invalidLock = fixture({ lockResult: null });
    await assert.rejects(applyAppleNotification(invalidLock.database, notification()), AppleSessionRevocationUnavailableError);
    assert.deepEqual(invalidLock.destroyed, [1]);
    const busy = fixture({ lockResult: 0 });
    await assert.rejects(applyAppleNotification(busy.database, notification()), AppleSessionRevocationUnavailableError);
    assert.deepEqual(busy.destroyed, []);
    assert.deepEqual(busy.released, [1]);
});

test('database outages and malformed time data do not count as successful verification', async () => {
    const outage = fixture({ fail: call => call.sql.startsWith('SELECT revoked_at') });
    await assert.rejects(assertFreshAppleSession(outage.reader, accountId, proof), AppleSessionRevocationUnavailableError);
    const malformed = fixture({ now: NaN });
    await assert.rejects(assertFreshAppleSession(malformed.reader, accountId, proof), AppleSessionRevocationUnavailableError);
    await assert.rejects(applyAppleNotification(fixture().database, notification({ eventTime: NOW + 31 })),
        AppleSessionRevocationUnavailableError);
});
