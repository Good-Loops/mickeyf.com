import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import { CookieOptions, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Pool, PoolConnection } from 'mysql2/promise';
import { createMainController } from '../controllers/mainController';

const sessionSecret = 'unit-test-session-secret-that-is-not-a-credential';

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
    } as unknown as Response;
    return { response, state };
}

function request(body: unknown, authorization?: string): Request {
    return {
        body,
        headers: authorization ? { authorization } : {},
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

test('successful login keeps the JWT only in the signed session cookie', async () => {
    const passwordHash = await bcrypt.hash('valid-password', 4);
    const database = {
        query: async () => [[{
            user_id: 42,
            user_name: 'player',
            user_password: passwordHash,
        }], []],
    } as unknown as Pick<Pool, 'getConnection' | 'query'>;
    const controller = createTestController(database, false);
    const { response, state } = responseRecorder();

    await controller(request({
        type: 'login',
        user_name: 'player',
        user_password: 'valid-password',
    }), response);

    assert.deepEqual(state.body, { success: true, user_name: 'player' });
    assert.equal(state.cookie?.name, 'session');
    assert.deepEqual(state.cookie?.options, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        signed: true,
        priority: 'high',
        path: '/',
        maxAge: 4 * 60 * 60 * 1000,
    });
    const cookieToken = state.cookie?.value;
    assert.equal(typeof cookieToken, 'string');
    const decoded = jwt.verify(cookieToken as string, sessionSecret, {
        algorithms: ['HS256'],
    });
    if (typeof decoded === 'string') {
        assert.fail('expected JWT object payload');
    }
    assert.equal(decoded.user_id, 42);
    assert.equal(decoded.user_name, 'player');
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
    const token = jwt.sign({ user_id: 42, user_name: 'player' }, sessionSecret, {
        algorithm: 'HS256',
        expiresIn: '5m',
    });

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

test('score submission still accepts the Bearer token fallback and authenticated identity', async () => {
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
            if (sql.includes('SELECT') && sql.includes('users.user_id AS userId')) {
                return [[{ userId: 42, score: 900 }], []];
            }
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
    const token = jwt.sign({ user_id: 42, user_name: 'player' }, sessionSecret, {
        algorithm: 'HS256',
        expiresIn: '5m',
    });

    await controller(request({
        type: 'submit_score',
        user_name: 'player',
        p4_score: 990,
    }, `Bearer ${token}`), response);

    assert.equal(state.status, 200);
    assert.deepEqual(state.body, { success: true, personalBest: true });
    assert.deepEqual(transactionEvents, [
        'query',
        'begin',
        'query',
        'query',
        'commit',
        'query',
        'release',
    ]);
    assert.deepEqual(queryValues, [
        [42, 5],
        ['p4-vega', 1, 42],
        ['p4-vega', 1, 42, 990],
        [42],
    ]);
    assert.equal(
        queryOptions.every((options) =>
            (options as { timeout?: number }).timeout === 10_000),
        true
    );
});

test('non-improving score preserves the exact legacy success response', async () => {
    let queryCount = 0;
    const connection = {
        async beginTransaction() {},
        async query(options: { sql: string }) {
            queryCount += 1;
            if (options.sql.includes('GET_LOCK') || options.sql.includes('RELEASE_LOCK')) {
                return [[{ lockResult: 1 }], []];
            }
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
    const token = jwt.sign({ user_id: 42, user_name: 'player' }, sessionSecret, {
        algorithm: 'HS256',
        expiresIn: '5m',
    });

    await controller(request({
        type: 'submit_score',
        p4_score: 900,
    }, `Bearer ${token}`), response);

    assert.equal(state.status, 200);
    assert.deepEqual(state.body, { success: true, personalBest: false });
    assert.equal(queryCount, 3);
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
