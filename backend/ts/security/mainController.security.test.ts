import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { CookieOptions, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Pool, PoolConnection } from 'mysql2/promise';
import { createMainController } from '../controllers/mainController';
import { issueSessionToken, sessionSigningKey } from './sessionPolicy';

const sessionSecret = 'unit-test-session-secret-that-is-not-a-credential';
const origins = ['https://mickeyf.com', 'capacitor://localhost'];
const account = { userId: 42, userName: 'player', accountId: '123e4567-e89b-42d3-a456-426614174000' };
const session = issueSessionToken(account, sessionSecret);

function responseRecorder() {
    const state: {
        status: number;
        body?: Record<string, unknown>;
        cookie?: { name: string; value: string; options: CookieOptions };
    } = { status: 200 };
    const response = {
        status(status: number) {
            state.status = status;
            return this;
        },
        json(body: Record<string, unknown>) {
            state.body = body;
            return this;
        },
        cookie(name: string, value: string, options: CookieOptions) {
            state.cookie = { name, value, options };
            return this;
        },
        clearCookie() { return this; },
    } as unknown as Response;
    return { response, state };
}

function request(body: unknown, authorization?: string, headers: Request['headers'] = {}): Request {
    return {
        body,
        headers: { 'content-type': 'application/json', origin: origins[0],
            ...(authorization ? { authorization } : {}), ...headers },
        signedCookies: {},
    } as Request;
}

function createTestController(
    database: Pick<Pool, 'getConnection' | 'query'>,
    p4VegaScoreSubmissionsEnabled = true
) {
    return createMainController({
        database,
        sessionSecret,
        isProduction: false,
        p4VegaScoreSubmissionsEnabled,
        allowedMutationOrigins: origins,
    });
}

test('invalid signup input is rejected before any database or bcrypt work', async () => {
    let queryCount = 0;
    const database = {
        query: async () => {
            queryCount += 1;
            throw new Error('database must not be called');
        },
    } as unknown as Pick<Pool, 'getConnection' | 'query'>;
    const controller = createTestController(database, false);
    const { response, state } = responseRecorder();

    await controller(request({ type: 'signup', user_name: 'player' }), response);

    assert.equal(queryCount, 0);
    assert.deepEqual(state.body, { error: 'EMPTY_FIELDS' });
});

test('invalid login input returns the generic authentication failure before persistence', async () => {
    let queryCount = 0;
    const database = {
        query: async () => {
            queryCount += 1;
            throw new Error('database must not be called');
        },
    } as unknown as Pick<Pool, 'getConnection' | 'query'>;
    const controller = createTestController(database);
    const { response, state } = responseRecorder();

    await controller(request({ type: 'login', user_name: 'player', user_password: 1234 }), response);

    assert.equal(queryCount, 0);
    assert.deepEqual(state.body, { error: 'AUTH_FAILED' });
});

test('database failures reject for the async wrapper and central error handler', async () => {
    const databaseFailure = new Error('sensitive database detail');
    const database = {
        query: async () => {
            throw databaseFailure;
        },
    } as unknown as Pick<Pool, 'getConnection' | 'query'>;
    const controller = createTestController(database);
    const { response } = responseRecorder();

    await assert.rejects(
        controller(request({
            type: 'signup',
            user_name: 'player',
            email: 'player@example.com',
            user_password: 'valid-password',
        }), response),
        databaseFailure
    );
});

test('untrusted login origins, non-JSON bodies and malformed persistence choices make no database calls', async () => {
    const database = {
        async query() { assert.fail('invalid login must not query'); },
        async getConnection() { assert.fail('invalid login must not acquire'); },
    } as unknown as Pick<Pool, 'getConnection' | 'query'>;
    const controller = createTestController(database);
    const body = { type: 'login', user_name: 'player', user_password: 'valid-password' };
    for (const headers of [{ origin: undefined }, { origin: 'null' }, { origin: 'https://attacker.example' }, { 'content-type': 'text/plain' }]) {
        const { response, state } = responseRecorder();
        await controller(request(body, undefined, headers), response);
        assert.equal(state.status, 403);
        assert.deepEqual(state.body, { error: 'AUTH_FAILED' });
        assert.equal(state.cookie, undefined);
    }
    for (const rememberMe of ['true', 1, null]) {
        const { response, state } = responseRecorder();
        await controller(request({ ...body, remember_me: rememberMe }), response);
        assert.deepEqual(state.body, { error: 'AUTH_FAILED' });
        assert.equal(state.cookie, undefined);
    }
});

test('login commits a revocable session before its signed cookie, with matching four-hour or thirty-day expiry', async () => {
    const passwordHash = await bcrypt.hash('valid-password', 4);
    for (const [rememberMe, seconds, origin] of [
        [undefined, 4 * 60 * 60, origins[0]],
        [false, 4 * 60 * 60, origins[0]],
        [true, 30 * 24 * 60 * 60, origins[0]],
        [false, 4 * 60 * 60, origins[1]],
    ] as const) {
        const { response, state } = responseRecorder();
        let inserted: unknown[] | undefined;
        let committed = false;
        const database = {
            async query(options: { sql: string; timeout: number }, values: unknown[]) {
                assert.match(options.sql.replace(/\s+/g, ' '), /SELECT user_id, account_uuid, user_name, user_password FROM users WHERE user_name = \? LIMIT 1/);
                assert.equal(options.timeout, 10_000);
                assert.deepEqual(values, ['player']);
                return [[{ user_id: 42, user_name: 'player', account_uuid: account.accountId, user_password: passwordHash }], []];
            },
            async getConnection() {
                return {
                    async query(options: { sql: string; timeout: number }, values?: unknown[]) {
                        const sql = options.sql.replace(/\s+/g, ' ').trim();
                        assert.equal(options.timeout, 10_000);
                        if (sql.includes('GET_LOCK')) { assert.deepEqual(values, [42, 5]); return [[{ lockResult: 1 }], []]; }
                        if (sql.includes('RELEASE_LOCK')) { assert.deepEqual(values, [42]); return [[{ lockResult: 1 }], []]; }
                        if (sql === 'START TRANSACTION') return [{ affectedRows: 0 }, []];
                        if (sql === 'COMMIT') {
                            assert.equal(state.cookie, undefined, 'never expose a cookie before the session commit');
                            assert.ok(inserted);
                            committed = true;
                            return [{ affectedRows: 0 }, []];
                        }
                        if (sql.startsWith('SELECT account_uuid AS accountId, user_password AS passwordHash')) {
                            assert.deepEqual(values, [42]);
                            return [[{ accountId: account.accountId, passwordHash }], []];
                        }
                        if (sql.startsWith('DELETE FROM account_sessions WHERE account_uuid = ? AND expires_at')) {
                            assert.deepEqual(values, [account.accountId]);
                            return [{ affectedRows: 0 }, []];
                        }
                        if (sql.startsWith('SELECT session_hash FROM account_sessions')) {
                            assert.deepEqual(values, [account.accountId]);
                            return [[], []];
                        }
                        assert.match(sql, /^INSERT INTO account_sessions /);
                        inserted = values;
                        return [{ affectedRows: 1 }, []];
                    },
                    release() {}, destroy() {},
                };
            },
        } as unknown as Pick<Pool, 'getConnection' | 'query'>;
        await createTestController(database, false)(request({ type: 'login', user_name: 'player',
            user_password: 'valid-password', ...(rememberMe === undefined ? {} : { remember_me: rememberMe }) },
            undefined, { origin }), response);

        assert.equal(committed, true);
        assert.deepEqual(state.body, { success: true, user_name: 'player' });
        assert.equal(state.cookie?.name, origin === origins[1] ? 'session' : '__session');
        assert.deepEqual(state.cookie?.options, { httpOnly: true, secure: false, sameSite: 'lax', signed: true,
            priority: 'high', path: '/', maxAge: seconds * 1000 });
        const decoded = jwt.verify(state.cookie!.value, sessionSigningKey(sessionSecret), { algorithms: ['HS256'] });
        if (typeof decoded === 'string') assert.fail('expected JWT object payload');
        assert.equal(decoded.user_id, 42);
        assert.equal(decoded.user_name, 'player');
        assert.equal(decoded.account_uuid, account.accountId);
        assert.equal(decoded.exp! - decoded.iat!, seconds);
        assert.deepEqual(inserted, [createHash('sha256').update(decoded.jti!, 'ascii').digest(), account.accountId,
            decoded.exp, rememberMe === true ? 1 : 0, decoded.exp, decoded.exp]);
    }
});

test('the submission freeze rejects anonymous and authenticated scores before database work', async () => {
    let queryCount = 0;
    let acquisitionCount = 0;
    const database = {
        async query() {
            queryCount += 1;
            throw new Error('frozen score submission must not query the database');
        },
        async getConnection() {
            acquisitionCount += 1;
            throw new Error('frozen score submission must not acquire a connection');
        },
    } as unknown as Pick<Pool, 'getConnection' | 'query'>;
    const controller = createTestController(database, false);
    const token = session.token;

    for (const authorization of [undefined, `Bearer ${token}`]) {
        const { response, state } = responseRecorder();
        await controller(request({
            type: 'submit_score',
            p4_score: 990,
        }, authorization), response);

        assert.equal(state.status, 503);
        assert.deepEqual(state.body, { error: 'SUBMISSIONS_FROZEN' });
    }

    assert.equal(queryCount, 0);
    assert.equal(acquisitionCount, 0);
});

test('failed durable session creation cannot issue a login cookie or return success', async () => {
    const passwordHash = await bcrypt.hash('valid-password', 4);
    const database = {
        async query(options: { sql: string }, values: unknown[]) {
            assert.match(options.sql, /SELECT user_id, account_uuid, user_name, user_password/);
            assert.deepEqual(values, ['player']);
            return [[{ user_id: 42, account_uuid: account.accountId, user_name: 'player', user_password: passwordHash }], []];
        },
        async getConnection() { throw new Error('private-driver-failure'); },
    } as unknown as Pick<Pool, 'getConnection' | 'query'>;
    const { response, state } = responseRecorder();
    await assert.rejects(createTestController(database)(request({ type: 'login', user_name: 'player',
        user_password: 'valid-password', remember_me: true }), response), { name: 'AccountSessionUnavailableError' });
    assert.equal(state.cookie, undefined);
    assert.equal(state.body, undefined);
});

test('enabled score submission rejects an anonymous request before database work', async () => {
    let queryCount = 0;
    let acquisitionCount = 0;
    const database = {
        async query() {
            queryCount += 1;
            throw new Error('anonymous score submission must not query the database');
        },
        async getConnection() {
            acquisitionCount += 1;
            throw new Error('anonymous score submission must not acquire a connection');
        },
    } as unknown as Pick<Pool, 'getConnection' | 'query'>;
    const controller = createTestController(database, true);
    const { response, state } = responseRecorder();

    await controller(request({
        type: 'submit_score',
        p4_score: 990,
    }), response);

    assert.equal(state.status, 401);
    assert.deepEqual(state.body, { error: 'UNAUTHORIZED' });
    assert.equal(queryCount, 0);
    assert.equal(acquisitionCount, 0);
});

test('p4 submissions reject cross-origin cookies and Bearer tokens before database acquisition', async () => {
    const database = {
        async query() { assert.fail('untrusted score submission must not query'); },
        async getConnection() { assert.fail('untrusted score submission must not acquire'); },
    } as unknown as Pick<Pool, 'getConnection' | 'query'>;
    const controller = createTestController(database);
    for (const bearer of [false, true]) {
        const req = request({ type: 'submit_score', p4_score: 900 }, bearer ? `Bearer ${session.token}` : undefined,
            { origin: 'https://attacker.example' });
        if (!bearer) req.signedCookies = { __session: session.token };
        const { response, state } = responseRecorder();
        await controller(req, response);
        assert.equal(state.status, 403);
        assert.deepEqual(state.body, { error: 'UNAUTHORIZED' });
    }
});

test('a completed 1000-point run accepts the Bearer fallback and improves the former 990-point maximum', async () => {
    const transactionEvents: string[] = [];
    const queryValues: Array<unknown[] | undefined> = [];
    const queryOptions: unknown[] = [];
    const connection = {
        async beginTransaction() {
            transactionEvents.push('begin');
        },
        async query(options: unknown, values?: unknown[]) {
            queryOptions.push(options);
            queryValues.push(values);
            transactionEvents.push('query');
            const sql = (options as { sql: string }).sql;
            if (sql.includes('GET_LOCK') || sql.includes('RELEASE_LOCK')) {
                return [[{ lockResult: 1 }], []];
            }
            if (sql.includes('FROM account_sessions AS s')) {
                const hash = createHash('sha256').update(session.sessionId, 'ascii').digest();
                assert.deepEqual(values, [42, account.accountId, hash, hash]);
                return [[{ userName: account.userName }], []];
            }
            if (sql.includes('SELECT') && sql.includes('users.user_id AS userId')) {
                return [[{ userId: 42, score: 990 }], []];
            }
            assert.match(sql, /INSERT INTO game_personal_bests/);
            return [{ affectedRows: 2 }, []];
        },
        async commit() {
            transactionEvents.push('commit');
        },
        async rollback() {
            transactionEvents.push('rollback');
        },
        release() {
            transactionEvents.push('release');
        },
    } as unknown as PoolConnection;
    const database = {
        query: async () => {
            throw new Error('score transaction must not use pool.query');
        },
        getConnection: async () => connection,
    } as unknown as Pick<Pool, 'getConnection' | 'query'>;
    const controller = createTestController(database);
    const { response, state } = responseRecorder();
    const token = session.token;

    await controller(request({
        type: 'submit_score',
        user_name: 'player',
        p4_score: 1000,
    }, `Bearer ${token}`), response);

    assert.equal(state.status, 200);
    assert.deepEqual(state.body, { success: true, personalBest: true });
    assert.deepEqual(transactionEvents, [
        'query',
        'begin',
        'query',
        'query',
        'query',
        'commit',
        'query',
        'release',
    ]);
    assert.deepEqual(queryValues, [
        [42, 5],
        [42, account.accountId, createHash('sha256').update(session.sessionId, 'ascii').digest(),
            createHash('sha256').update(session.sessionId, 'ascii').digest()],
        ['p4-vega', 1, 42],
        ['p4-vega', 1, 42, 1000],
        [42],
    ]);
    assert.equal(
        queryOptions.every((options) =>
            (options as { timeout?: number }).timeout === 10_000),
        true
    );
});

test('scores above the completion limit are rejected before database acquisition', async () => {
    const database = {
        async query() { assert.fail('invalid score must not query'); },
        async getConnection() { assert.fail('invalid score must not acquire a connection'); },
    } as unknown as Pick<Pool, 'getConnection' | 'query'>;
    const controller = createTestController(database);
    const token = session.token;

    for (const score of [1001, 1010]) {
        const { response, state } = responseRecorder();
        await controller(request({ type: 'submit_score', p4_score: score }, `Bearer ${token}`), response);
        assert.equal(state.status, 400);
        assert.deepEqual(state.body, { error: 'INVALID_SCORE' });
    }
});

test('non-improving score preserves the exact legacy success response', async () => {
    let queryCount = 0;
    const connection = {
        async beginTransaction() {},
        async query(options: { sql: string }, values?: unknown[]) {
            queryCount += 1;
            if (options.sql.includes('GET_LOCK') || options.sql.includes('RELEASE_LOCK')) {
                return [[{ lockResult: 1 }], []];
            }
            if (options.sql.includes('FROM account_sessions AS s')) {
                const hash = createHash('sha256').update(session.sessionId, 'ascii').digest();
                assert.deepEqual(values, [42, account.accountId, hash, hash]);
                return [[{ userName: account.userName }], []];
            }
            assert.match(options.sql, /users.user_id AS userId/);
            return [[{ userId: 42, score: 900 }], []];
        },
        async commit() {},
        async rollback() {},
        release() {},
    } as unknown as PoolConnection;
    const database = {
        query: async () => {
            throw new Error('score transaction must not use pool.query');
        },
        getConnection: async () => connection,
    } as unknown as Pick<Pool, 'getConnection' | 'query'>;
    const controller = createTestController(database);
    const { response, state } = responseRecorder();
    const token = session.token;

    await controller(request({
        type: 'submit_score',
        p4_score: 900,
    }, `Bearer ${token}`), response);

    assert.equal(state.status, 200);
    assert.deepEqual(state.body, { success: true, personalBest: false });
    assert.equal(queryCount, 4);
});

test('legacy leaderboard operation adapts the bounded generic read', async () => {
    let queryCount = 0;
    let queryOptions: unknown;
    let queryValues: unknown[] | undefined;
    const database = {
        query: async (options: unknown, values?: unknown[]) => {
            queryCount += 1;
            queryOptions = options;
            queryValues = values;
            return [[{ userName: 'player', score: 990, internalId: 42 }], []];
        },
    } as unknown as Pick<Pool, 'getConnection' | 'query'>;
    const controller = createTestController(database, false);
    const { response, state } = responseRecorder();

    await controller(request({ type: 'get_leaderboard' }), response);

    assert.equal(queryCount, 1);
    assert.deepEqual(queryValues, ['p4-vega', 1]);
    const options = queryOptions as { sql?: string; timeout?: number };
    assert.equal(options.timeout, 10_000);
    assert.equal(
        options.sql?.replace(/\s+/g, ' ').trim(),
        'SELECT users.user_name AS userName, game_personal_bests.score AS score FROM game_personal_bests INNER JOIN users ON users.user_id = game_personal_bests.user_id WHERE game_personal_bests.game_id = ? AND game_personal_bests.rules_version = ? ORDER BY game_personal_bests.score DESC, game_personal_bests.recorded_at ASC, game_personal_bests.user_id ASC LIMIT 10'
    );
    assert.deepEqual(state.body, {
        success: true,
        leaderboard: [{ user_name: 'player', p4_score: 990 }],
    });
});
