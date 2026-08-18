import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Pool } from 'mysql2/promise';
import { createMainController } from '../controllers/mainController';

const sessionSecret = 'unit-test-session-secret-that-is-not-a-credential';

function responseRecorder() {
    const state: {
        status: number;
        body?: Record<string, unknown>;
        cookie?: { name: string; value: string; options: unknown };
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
        cookie(name: string, value: string, options: unknown) {
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

test('invalid signup input is rejected before any database or bcrypt work', async () => {
    let queryCount = 0;
    const database = {
        query: async () => {
            queryCount += 1;
            throw new Error('database must not be called');
        },
    } as unknown as Pick<Pool, 'query'>;
    const controller = createMainController({ database, sessionSecret, isProduction: false });
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
    } as unknown as Pick<Pool, 'query'>;
    const controller = createMainController({ database, sessionSecret, isProduction: false });
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
    } as unknown as Pick<Pool, 'query'>;
    const controller = createMainController({ database, sessionSecret, isProduction: false });
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

test('successful login preserves the JWT response and signed session cookie contract', async () => {
    const passwordHash = await bcrypt.hash('valid-password', 4);
    const database = {
        query: async () => [[{
            user_id: 42,
            user_name: 'player',
            user_password: passwordHash,
        }], []],
    } as unknown as Pick<Pool, 'query'>;
    const controller = createMainController({ database, sessionSecret, isProduction: false });
    const { response, state } = responseRecorder();

    await controller(request({
        type: 'login',
        user_name: 'player',
        user_password: 'valid-password',
    }), response);

    assert.equal(state.body?.success, true);
    assert.equal(state.body?.user_name, 'player');
    assert.equal(typeof state.body?.token, 'string');
    assert.equal(state.cookie?.name, 'session');
    assert.equal(state.cookie?.value, state.body?.token);
    const decoded = jwt.verify(state.body?.token as string, sessionSecret, {
        algorithms: ['HS256'],
    });
    if (typeof decoded === 'string') {
        assert.fail('expected JWT object payload');
    }
    assert.equal(decoded.user_id, 42);
    assert.equal(decoded.user_name, 'player');
});

test('score submission still accepts the Bearer token fallback and authenticated identity', async () => {
    let queryValues: unknown[] | undefined;
    let queryOptions: unknown;
    const database = {
        query: async (options: unknown, values?: unknown[]) => {
            queryOptions = options;
            queryValues = values;
            return [{ affectedRows: 1 }, []];
        },
    } as unknown as Pick<Pool, 'query'>;
    const controller = createMainController({ database, sessionSecret, isProduction: false });
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
    assert.deepEqual(queryValues, [990, 42, 990]);
    assert.equal((queryOptions as { timeout?: number }).timeout, 10_000);
});

test('leaderboard smoke operation remains a bounded read-only query', async () => {
    let queryCount = 0;
    let queryOptions: unknown;
    let queryValues: unknown[] | undefined;
    const database = {
        query: async (options: unknown, values?: unknown[]) => {
            queryCount += 1;
            queryOptions = options;
            queryValues = values;
            return [[{ user_name: 'player', p4_score: 990 }], []];
        },
    } as unknown as Pick<Pool, 'query'>;
    const controller = createMainController({ database, sessionSecret, isProduction: false });
    const { response, state } = responseRecorder();

    await controller(request({ type: 'get_leaderboard' }), response);

    assert.equal(queryCount, 1);
    assert.equal(queryValues, undefined);
    const options = queryOptions as { sql?: string; timeout?: number };
    assert.equal(options.timeout, 10_000);
    assert.equal(
        options.sql?.replace(/\s+/g, ' ').trim(),
        'SELECT user_name, p4_score FROM users WHERE p4_score IS NOT NULL ORDER BY p4_score DESC LIMIT 10'
    );
    assert.deepEqual(state.body, {
        success: true,
        leaderboard: [{ user_name: 'player', p4_score: 990 }],
    });
});
