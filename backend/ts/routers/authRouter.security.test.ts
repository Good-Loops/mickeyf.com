import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import express from 'express';
import { Pool } from 'mysql2/promise';
import { createMainController } from '../controllers/mainController';
import { issueThreeBossesRunTicket } from '../leaderboards/threeBossesRunTicket';
import { asyncHandler, requestErrorHandler } from '../middleware/errorHandling';
import { createAuthRouter } from './authRouter';
import { createLeaderboardRouter } from './leaderboardRouter';
import { issueSessionToken } from '../security/sessionPolicy';

const secret = 'account-deletion-test-secret-not-a-credential';
const password = 'unit-test-password';
const origins = ['https://mickeyf.com', 'capacitor://localhost'];
const account = { userId: 42, userName: 'player', accountId: '123e4567-e89b-42d3-a456-426614174000' };
const primarySession = issueSessionToken(account, secret, true);
const otherSession = issueSessionToken(account, secret);
const token = primarySession.token;
const sessionHash = (id: string) => createHash('sha256').update(id, 'ascii').digest('hex');
function signedCookie(value: string, name = '__session') {
    const signature = createHmac('sha256', secret).update(value).digest('base64').replace(/=+$/, '');
    return `${name}=${encodeURIComponent(`s:${value}.${signature}`)}`;
}
const cookie = signedCookie(token);
const deletion = { password, confirmation: 'DELETE' };

// In-memory HTTP boundary fixture only: no dbConfig import, credentials, or real connection.
type TestState = {
    exists: boolean; unavailable: boolean; writes: string[]; databaseCalls: number;
    journalCalls: number; journalUnavailable: boolean; commitUnavailable: boolean;
    accountId: string; sessions: Map<string, number>; revokedSessions: string[];
};

async function withServer(
    run: (base: string, state: TestState) => Promise<void>,
    options: { accountDeletionEnabled?: boolean; withoutJournal?: boolean } = { accountDeletionEnabled: true }
) {
    const passwordHash = await bcrypt.hash(password, 4);
    const state: TestState = { exists: true, unavailable: false, writes: [], databaseCalls: 0,
        journalCalls: 0, journalUnavailable: false, commitUnavailable: false,
        accountId: account.accountId, revokedSessions: [], sessions: new Map([
            [sessionHash(primarySession.sessionId), primarySession.expiresAt],
            [sessionHash(otherSession.sessionId), otherSession.expiresAt],
        ]) };
    async function query(options: { sql: string; timeout?: number }, values?: unknown[]) {
        state.databaseCalls++;
        if (state.unavailable) throw new Error('private-database-error');
        const sql = options.sql.replace(/\s+/g, ' ').trim();
        assert.equal(options.timeout, 10_000);
        if (sql.includes('GET_LOCK')) { assert.deepEqual(values, [42, 5]); return [[{ lockResult: 1 }], []]; }
        if (sql.includes('RELEASE_LOCK')) { assert.deepEqual(values, [42]); return [[{ lockResult: 1 }], []]; }
        if (sql.startsWith('SELECT user_id, account_uuid, user_name, user_password FROM users')) {
            assert.deepEqual(values, ['player']);
            return [state.exists ? [{ user_id: 42, account_uuid: state.accountId, user_name: 'player', user_password: passwordHash }] : [], []];
        }
        if (sql.startsWith('SELECT account_uuid AS accountId, user_password AS passwordHash FROM users')) {
            assert.deepEqual(values, [42]);
            return [state.exists ? [{ accountId: state.accountId, passwordHash }] : [], []];
        }
        if (sql.startsWith('DELETE FROM account_sessions WHERE account_uuid = ? AND expires_at')) {
            assert.deepEqual(values, [state.accountId]);
            let deleted = 0;
            for (const [hash, expiresAt] of state.sessions) {
                if (expiresAt <= Date.now() / 1000) { state.sessions.delete(hash); deleted++; }
            }
            return [{ affectedRows: deleted }, []];
        }
        if (sql.startsWith('SELECT session_hash FROM account_sessions WHERE account_uuid = ?')) {
            assert.deepEqual(values, [state.accountId]);
            return [[...state.sessions.keys()].map(hash => ({ session_hash: Buffer.from(hash, 'hex') })), []];
        }
        if (sql.startsWith('INSERT INTO account_sessions (session_hash, account_uuid, created_at, expires_at)')) {
            assert.ok(values && values.length === 5 && Buffer.isBuffer(values[0]));
            assert.equal(values[1], state.accountId);
            const expiresAt = values[2] as number;
            assert.ok(expiresAt > Date.now() / 1000 && expiresAt <= Date.now() / 1000 + 30 * 24 * 60 * 60);
            assert.deepEqual(values.slice(2), [expiresAt, expiresAt, expiresAt]);
            state.sessions.set(values[0].toString('hex'), expiresAt);
            return [{ affectedRows: 1 }, []];
        }
        if (sql.includes('FROM account_sessions AS s') || sql.startsWith('DELETE s FROM account_sessions AS s')) {
            assert.match(sql, /u.user_id = \? AND u.account_uuid = \? AND s.session_hash = \?/);
            assert.ok(values && values.length === 3);
            assert.equal(values[0], 42);
            assert.ok(Buffer.isBuffer(values[2]));
            const hash = values[2].toString('hex');
            const ownsSession = state.exists && values[1] === state.accountId;
            if (sql.startsWith('DELETE s')) {
                const deleted = ownsSession && state.sessions.delete(hash);
                if (deleted) state.revokedSessions.push(hash);
                return [{ affectedRows: deleted ? 1 : 0 }, []];
            }
            assert.match(sql, /s.expires_at > UTC_TIMESTAMP\(6\)/);
            const live = ownsSession && (state.sessions.get(hash) ?? 0) > Date.now() / 1000;
            return [live ? [{ userName: account.userName }] : [], []];
        }
        if (sql.startsWith('SELECT user_password AS passwordHash, account_uuid AS accountId')) {
            assert.deepEqual(values, [42]);
            return [state.exists ? [{ passwordHash, userName: 'player', user_id: 42,
                accountId: state.accountId }] : [], []];
        }
        assert.match(sql, /^DELETE FROM (game_personal_bests|game_submission_receipts|users) WHERE user_id = \?$/);
        assert.deepEqual(values, [42]);
        state.writes.push(sql);
        if (sql.startsWith('DELETE FROM users')) { state.exists = false; state.sessions.clear(); }
        return [{ affectedRows: 1 }, []];
    }
    const database = {
        query,
        async getConnection() {
            state.databaseCalls++;
            let snapshot: { exists: boolean; sessions: Map<string, number>; writes: string[]; revokedSessions: string[] } | null = null;
            const beginTransaction = async () => {
                snapshot = { exists: state.exists, sessions: new Map(state.sessions),
                    writes: [...state.writes], revokedSessions: [...state.revokedSessions] };
            };
            const commit = async () => {
                if (state.commitUnavailable) throw new Error('commit acknowledgement lost');
                snapshot = null;
            };
            const rollback = async () => {
                if (snapshot) Object.assign(state, snapshot);
                snapshot = null;
            };
            return {
                async query(options: { sql: string; timeout: number }, values?: unknown[]) {
                    if (['START TRANSACTION', 'COMMIT', 'ROLLBACK'].includes(options.sql)) {
                        assert.equal(options.timeout, 10_000);
                        if (options.sql === 'START TRANSACTION') await beginTransaction();
                        if (options.sql === 'COMMIT') await commit();
                        if (options.sql === 'ROLLBACK') await rollback();
                        return [{ affectedRows: 0 }, []];
                    }
                    return query(options, values);
                },
                beginTransaction, commit, rollback, release() {}, destroy() {},
            };
        },
    } as unknown as Pick<Pool, 'query' | 'getConnection'>;
    const app = express();
    app.use(cookieParser(secret), express.json());
    app.use('/auth', createAuthRouter(database, secret, true, origins, {
        accountDeletionEnabled: options.accountDeletionEnabled,
        deletionJournal: options.withoutJournal ? undefined : {
            async recordAccountDeletion() {
                state.journalCalls++;
                if (state.journalUnavailable) throw new Error('journal acknowledgement unavailable');
            },
        },
    }));
    app.post('/api/users', asyncHandler(createMainController({ database, sessionSecret: secret, isProduction: true,
        p4VegaScoreSubmissionsEnabled: true, allowedMutationOrigins: origins })));
    app.use('/api/leaderboards', createLeaderboardRouter(database, {
        sessionSecret: secret, allowedMutationOrigins: origins, threeBossesRunSubmissionsEnabled: true,
    }));
    app.use(requestErrorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, state);
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

function post(base: string, body: unknown, headers: Record<string, string> = {}, path = '/auth/delete-account') {
    return fetch(base + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origins[0], ...headers },
        body: JSON.stringify(body),
    });
}

test('disabled or unwired deletion makes no database calls and leaves other auth routes usable', async () => {
    for (const options of [{}, { accountDeletionEnabled: false }, { accountDeletionEnabled: true, withoutJournal: true }]) {
        await withServer(async (base, state) => {
            state.unavailable = true;
            for (const origin of origins) {
                const response = await post(base, deletion, { Origin: origin });
                assert.equal(response.status, 503);
                assert.deepEqual(await response.json(), { error: 'ACCOUNT_DELETION_UNAVAILABLE' });
                assert.equal(response.headers.get('set-cookie'), null);
            }
            assert.equal(state.databaseCalls, 0);
            assert.equal(state.journalCalls, 0);
            assert.deepEqual(state.writes, []);
            assert.equal(state.exists, true);

            state.unavailable = false;
            const session = await fetch(base + '/auth/verify-token', { headers: { Cookie: cookie } });
            assert.deepEqual(await session.json(), { loggedIn: true, user_name: 'player' });
            assert.equal(session.headers.get('set-cookie'), null);
            const logout = await post(base, {}, {}, '/auth/logout');
            assert.equal(logout.status, 200);
            assert.match(logout.headers.get('set-cookie')!, /^__session=.*Expires=Thu, 01 Jan 1970/);
            assert.equal(state.exists, true);
            assert.deepEqual(state.writes, []);
        }, options);
    }
});

test('logout revokes copied credentials for this device while another device remains signed in', async () => {
    for (const [name, origin] of [['__session', origins[0]], ['session', origins[1]]]) {
        await withServer(async (base, state) => {
            const deviceCookie = signedCookie(token, name);
            const logout = await post(base, {}, { Cookie: deviceCookie, Origin: origin }, '/auth/logout');
            assert.equal(logout.status, 200);
            assert.deepEqual(await logout.json(), { loggedOut: true });
            assert.deepEqual(state.revokedSessions, [sessionHash(primarySession.sessionId)]);
            for (const headers of [{ Cookie: deviceCookie }, { Authorization: `Bearer ${token}` }] as Record<string, string>[]) {
                const copied = await fetch(base + '/auth/verify-token', { headers });
                assert.deepEqual(await copied.json(), { loggedIn: false });
                assert.equal(copied.headers.get('set-cookie'), null);
            }
            assert.equal((await post(base, { type: 'submit_score', p4_score: 900 }, {}, '/api/users')).status, 401);
            assert.equal((await post(base, deletion)).status, 401);
            assert.equal(state.journalCalls, 0);
            assert.deepEqual(state.writes, []);
            const otherDevice = await fetch(base + '/auth/verify-token', { headers: { Cookie: signedCookie(otherSession.token) } });
            assert.deepEqual(await otherDevice.json(), { loggedIn: true, user_name: 'player' });
            assert.equal(state.sessions.has(sessionHash(otherSession.sessionId)), true);
        });
    }
});

test('a new login replaces the presented device session without reviving its copied cookie', async () => {
    await withServer(async (base, state) => {
        const login = await post(base, { type: 'login', user_name: 'player', user_password: password, remember_me: true }, {}, '/api/users');
        assert.equal(login.status, 200);
        assert.deepEqual(await login.json(), { success: true, user_name: 'player' });
        const newCookie = login.headers.getSetCookie()
            .find(value => value.startsWith('__session=') && !value.includes('Expires=Thu, 01 Jan 1970'))?.split(';')[0];
        assert.ok(newCookie && newCookie !== cookie);
        assert.deepEqual(state.revokedSessions, [sessionHash(primarySession.sessionId)]);
        assert.equal(state.sessions.size, 2, 'the old device is replaced, not added to the retained device list');
        for (const [savedCookie, loggedIn] of [[cookie, false], [newCookie, true], [signedCookie(otherSession.token), true]] as const) {
            const verification = await fetch(base + '/auth/verify-token', { headers: { Cookie: savedCookie } });
            assert.deepEqual(await verification.json(), loggedIn ? { loggedIn: true, user_name: 'player' } : { loggedIn: false });
        }
        const logout = await post(base, {}, { Cookie: newCookie }, '/auth/logout');
        assert.deepEqual(await logout.json(), { loggedOut: true });
        assert.equal(state.sessions.size, 1);
        assert.equal(state.sessions.has(sessionHash(otherSession.sessionId)), true);
        assert.deepEqual(await (await fetch(base + '/auth/verify-token', { headers: { Cookie: newCookie } })).json(), { loggedIn: false });
        assert.deepEqual(await (await fetch(base + '/auth/verify-token', { headers: { Cookie: cookie } })).json(), { loggedIn: false });
    });
});

test('a rejected replacement login preserves the existing device session', async () => {
    await withServer(async (base, state) => {
        const login = await post(base, { type: 'login', user_name: 'player', user_password: 'incorrect' }, {}, '/api/users');
        assert.deepEqual(await login.json(), { error: 'AUTH_FAILED' });
        assert.equal(login.headers.get('set-cookie'), null);
        assert.deepEqual(state.revokedSessions, []);
        assert.equal(state.sessions.size, 2);
        assert.deepEqual(await (await fetch(base + '/auth/verify-token', { headers: { Cookie: cookie } })).json(),
            { loggedIn: true, user_name: 'player' });
    });
});

test('expired database sessions and a reused numeric user ID cannot verify or mutate the replacement account', async () => {
    for (const scenario of ['expired-session', 'replacement-account']) {
        await withServer(async (base, state) => {
            if (scenario === 'expired-session') state.sessions.set(sessionHash(primarySession.sessionId), Date.now() / 1000 - 1);
            else state.accountId = '123e4567-e89b-42d3-a456-426614174099';
            const verification = await fetch(base + '/auth/verify-token', { headers: { Cookie: cookie } });
            assert.deepEqual(await verification.json(), { loggedIn: false });
            assert.equal(verification.headers.get('set-cookie'), null);
            const run = { contractVersion: 1, rulesVersion: 1, runId: '123e4567-e89b-42d3-a456-426614174000' };
            assert.equal((await post(base, run, {}, '/api/leaderboards/three-bosses/run-tickets')).status, 401);
            assert.equal((await post(base, { type: 'submit_score', p4_score: 900 }, {}, '/api/users')).status, 401);
            assert.equal((await post(base, deletion)).status, 401);
            assert.equal(state.exists, true);
            assert.deepEqual(state.writes, []);
            assert.equal(state.journalCalls, 0);
        });
    }
});

test('an expired v2 JWT is rejected before any database lookup', async () => {
    await withServer(async (base, state) => {
        const expired = issueSessionToken(account, secret, false, Date.now() - 5 * 60 * 60 * 1000);
        const expiredCookie = signedCookie(expired.token);
        const response = await fetch(base + '/auth/verify-token', { headers: { Cookie: expiredCookie } });
        assert.deepEqual(await response.json(), { loggedIn: false });
        assert.equal((await post(base, { type: 'submit_score', p4_score: 900 }, { Cookie: expiredCookie }, '/api/users')).status, 401);
        assert.equal(state.databaseCalls, 0);
    });
});

test('unconfirmed or untrusted logout cannot discard credentials or claim successful revocation', async () => {
    await withServer(async (base, state) => {
        const untrusted = await post(base, {}, { Origin: 'https://attacker.example' }, '/auth/logout');
        assert.equal(untrusted.status, 403);
        assert.equal(untrusted.headers.get('set-cookie'), null);
        assert.equal(state.databaseCalls, 0);

        state.unavailable = true;
        const unavailable = await post(base, {}, {}, '/auth/logout');
        assert.equal(unavailable.status, 503);
        assert.deepEqual(await unavailable.json(), { error: 'LOGOUT_UNAVAILABLE' });
        assert.equal(unavailable.headers.get('set-cookie'), null);
        assert.deepEqual(state.revokedSessions, []);
        state.unavailable = false;
        assert.deepEqual(await (await fetch(base + '/auth/verify-token', { headers: { Cookie: cookie } })).json(),
            { loggedIn: true, user_name: 'player' });
        const retry = await post(base, {}, {}, '/auth/logout');
        assert.deepEqual(await retry.json(), { loggedOut: true });
        assert.deepEqual(state.revokedSessions, [sessionHash(primarySession.sessionId)]);
    });
});

test('requires authenticated ownership, trusted Origin and exact confirmation before persistence', async () => {
    for (const scenario of [
        { body: deletion, headers: { Cookie: '' }, status: 401 },
        { body: deletion, headers: { Origin: 'https://attacker.example' }, status: 403 },
        { body: deletion, headers: { Origin: 'null' }, status: 403 },
        { body: deletion, headers: { 'Content-Type': 'text/plain' }, status: 400 },
        { body: { ...deletion, user_id: 99 }, headers: {}, status: 400 },
        { body: { ...deletion, confirmation: 'delete' }, headers: {}, status: 400 },
        { body: { ...deletion, password: 'x'.repeat(73) }, headers: {}, status: 400 },
    ]) {
        await withServer(async (base, state) => {
            const response = await post(base, scenario.body, scenario.headers as Record<string, string>);
            assert.equal(response.status, scenario.status);
            assert.equal(response.headers.get('set-cookie'), null);
            assert.deepEqual(state.writes, []);
            assert.equal(state.exists, true);
        });
    }
    await withServer(async (base, state) => {
        const response = await fetch(base + '/auth/delete-account', {
            method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(deletion),
        });
        assert.equal(response.status, 403);
        assert.deepEqual(state.writes, []);
    });
});

test('wrong password preserves account/session and repeated guesses are limited', async () => {
    await withServer(async (base, state) => {
        for (let attempt = 0; attempt < 5; attempt++) {
            const response = await post(base, { ...deletion, password: 'incorrect' });
            assert.equal(response.status, 403);
            assert.deepEqual(await response.json(), { error: 'INVALID_PASSWORD' });
            assert.equal(response.headers.get('set-cookie'), null);
        }
        assert.equal((await post(base, deletion)).status, 429);
        assert.equal(state.exists, true);
        assert.deepEqual(state.writes, []);
    });
});

test('deletion works for web/native origins and rejects old sessions, tickets and p4 retries', async () => {
    for (const origin of origins) {
        await withServer(async (base, state) => {
            const before = await fetch(base + '/auth/verify-token', { headers: { Cookie: cookie } });
            assert.deepEqual(await before.json(), { loggedIn: true, user_name: 'player' });
            const run = { contractVersion: 1, rulesVersion: 1, runId: '123e4567-e89b-42d3-a456-426614174000' } as const;
            const ticket = await post(base, run, {}, '/api/leaderboards/three-bosses/run-tickets');
            assert.equal(ticket.status, 201);
            const issued = issueThreeBossesRunTicket(secret, account, run, Date.now() - 50_000);
            const result = await post(base, deletion, { Origin: origin });
            assert.equal(result.status, 200);
            assert.deepEqual(await result.json(), { deleted: true });
            assert.match(result.headers.get('set-cookie')!, /^__session=.*Expires=Thu, 01 Jan 1970.*HttpOnly; Secure;.*SameSite=Lax/);
            assert.ok(result.headers.getSetCookie().some(value => /^session=.*SameSite=None/.test(value)));
            assert.equal(state.writes.length, 3);
            const after = await fetch(base + '/auth/verify-token', { headers: { Cookie: cookie } });
            assert.deepEqual(await after.json(), { loggedIn: false });
            assert.equal(after.headers.get('set-cookie'), null);
            assert.equal((await post(base, run, {}, '/api/leaderboards/three-bosses/run-tickets')).status, 401);
            assert.equal((await post(base, { type: 'submit_score', p4_score: 900 }, {}, '/api/users')).status, 401);
            // Even a previously issued ticket cannot cause a write for the deleted identity.
            const replay = await post(base, { ...run, completionTimeMs: 50_000, runTicket: issued.runTicket }, {}, '/api/leaderboards/three-bosses/runs');
            assert.equal(replay.status, 401);
            assert.equal((await post(base, deletion)).status, 401);
            assert.equal(state.writes.length, 3);
        });
    }
});

test('database unavailability never reports successful deletion or discards credentials', async () => {
    await withServer(async (base, state) => {
        state.unavailable = true;
        const response = await post(base, deletion);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: 'ACCOUNT_DELETION_UNAVAILABLE' });
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(state.exists, true);
    });
});

test('journal uncertainty prevents SQL deletion; recorded intent with uncertain commit returns pending', async () => {
    for (const failure of ['journalUnavailable', 'commitUnavailable'] as const) {
        await withServer(async (base, state) => {
            state[failure] = true;
            const response = await post(base, deletion);
            assert.equal(response.status, 503);
            assert.deepEqual(await response.json(), { error: failure === 'journalUnavailable'
                ? 'ACCOUNT_DELETION_UNAVAILABLE' : 'ACCOUNT_DELETION_PENDING' });
            assert.equal(response.headers.get('set-cookie'), null);
            assert.equal(state.journalCalls, 1);
            if (failure === 'journalUnavailable') {
                assert.deepEqual(state.writes, []);
                assert.equal(state.exists, true);
            }
        });
    }
});
