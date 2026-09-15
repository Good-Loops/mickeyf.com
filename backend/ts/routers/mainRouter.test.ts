import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';
import cookieParser from 'cookie-parser';
import express from 'express';
import type { Pool } from 'mysql2/promise';
import { notFoundHandler, requestErrorHandler } from '../middleware/errorHandling';
import { createMainRouter } from './mainRouter';

const sessionSecret = 'main-router-test-secret-not-a-credential';
const allowedOrigin = 'https://router.example.test';
const signup = {
    type: 'signup',
    user_name: 'router-player',
    email: 'router@example.test',
    user_password: 'router-test-password',
};

function createFakeDatabase(failure?: Error) {
    const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
    // The driver has generic overloads; this double implements only the exercised calls.
    const database = {
        async query(options: { sql: string }, values?: unknown[]) {
            queries.push({ sql: options.sql, values });
            if (failure) throw failure;
            return [[{ userName: 'router-player', score: 100 }], []];
        },
        async getConnection() {
            assert.fail('router composition tests must not acquire a connection');
        },
    } as unknown as Pick<Pool, 'getConnection' | 'query'>;
    return { database, queries };
}

async function withServer(
    fake: ReturnType<typeof createFakeDatabase>,
    run: (baseUrl: string) => Promise<void>
): Promise<void> {
    const router = createMainRouter({
        database: fake.database,
        sessionSecret,
        isProduction: false,
        p4VegaScoreSubmissionsEnabled: false,
        allowedMutationOrigins: [allowedOrigin],
    });
    assert.equal(fake.queries.length, 0);

    const app = express();
    app.use(cookieParser(sessionSecret));
    app.use(express.json({ limit: '32kb', strict: true }));
    app.use('/api', router);
    app.use(notFoundHandler);
    app.use(requestErrorHandler);

    const server = app.listen(0, '127.0.0.1');
    try {
        await once(server, 'listening');
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolveClose, reject) => {
            server.close(error => error ? reject(error) : resolveClose());
        });
    }
}

async function post(baseUrl: string, body: unknown) {
    const response = await fetch(`${baseUrl}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: allowedOrigin },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
}

test('cold router import needs no runtime database configuration or cached module', () => {
    const environment: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'TEMP', 'TMP']) {
        if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    const result = spawnSync(process.execPath, [
        '-r', require.resolve('ts-node/register'),
        '-e', `const assert = require('node:assert/strict');
            assert.equal(typeof require(process.argv[1]).createMainRouter, 'function');`,
        resolve(__dirname, 'mainRouter.ts'),
    ], {
        cwd: resolve(__dirname, '../..'),
        env: environment,
        encoding: 'utf8',
        timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
});

test('construction, GET guidance and unmatched methods do not call persistence', async () => {
    const fake = createFakeDatabase();
    await withServer(fake, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/users`);
        assert.equal(response.status, 200);
        assert.equal(await response.text(),
            'GET request to /api/users is not supported. Please use POST.');
        assert.equal(response.headers.get('set-cookie'), null);

        const head = await fetch(`${baseUrl}/api/users`, { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(await head.text(), '');
        for (const [method, path] of [['PUT', '/api/users'], ['POST', '/api/unknown']]) {
            const missing = await fetch(baseUrl + path, { method });
            assert.equal(missing.status, 404);
            assert.deepEqual(await missing.json(), { error: 'NOT_FOUND' });
        }
    });
    assert.equal(fake.queries.length, 0);
});

test('POST dispatch reaches the injected database and preserves the duplicate response', async () => {
    const fake = createFakeDatabase();
    await withServer(fake, async baseUrl => {
        const response = await post(baseUrl, signup);
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { error: 'DUPLICATE_USER', status: 409 });
        assert.equal(response.headers.get('set-cookie'), null);
    });
    assert.equal(fake.queries.length, 1);
    assert.deepEqual(fake.queries[0].values, [signup.user_name, signup.email]);
});

test('invalid operations and invalid auth inputs short-circuit before persistence', async () => {
    const fake = createFakeDatabase();
    await withServer(fake, async baseUrl => {
        for (const [body, error] of [
            [{}, 'INVALID_TYPE'],
            [{ type: 'unknown' }, 'INVALID_TYPE'],
            [{ type: 'signup' }, 'EMPTY_FIELDS'],
            [{ type: 'login', user_name: 'router-player' }, 'AUTH_FAILED'],
        ] as const) {
            const response = await post(baseUrl, body);
            assert.equal(response.status, 200);
            assert.deepEqual(response.body, { error });
            assert.equal(response.headers.get('set-cookie'), null);
        }
    });
    assert.equal(fake.queries.length, 0);
});

test('login account limit blocks attempt 21 while signup and reads skip its bucket', async () => {
    const fake = createFakeDatabase();
    await withServer(fake, async baseUrl => {
        // Invalid passwords avoid bcrypt/SQL while still exercising the real limiters.
        for (let attempt = 0; attempt < 20; attempt++) {
            const response = await post(baseUrl, {
                type: 'login', user_name: attempt % 2 === 0 ? ' Router-Player ' : 'router-player',
            });
            assert.equal(response.status, 200);
            assert.deepEqual(response.body, { error: 'AUTH_FAILED' });
        }
        const blocked = await post(baseUrl, {
            type: 'login', user_name: 'ROUTER-PLAYER', user_password: signup.user_password,
        });
        assert.equal(blocked.status, 429);
        assert.deepEqual(blocked.body, { error: 'RATE_LIMITED' });
        assert.match(blocked.headers.get('ratelimit-policy') ?? '', /q=50.*q=20/);
        assert.equal(fake.queries.length, 0);

        const signupResponse = await post(baseUrl, signup);
        assert.equal(signupResponse.status, 200);
        assert.deepEqual(signupResponse.body, { error: 'DUPLICATE_USER', status: 409 });
        const read = await post(baseUrl, { type: 'get_leaderboard', user_name: signup.user_name });
        assert.equal(read.status, 200);
        assert.deepEqual(read.body, { success: true, leaderboard: [{ user_name: 'router-player', p4_score: 100 }] });
    });
    assert.equal(fake.queries.length, 2);
});

test('shared auth IP limit blocks attempt 51 while non-auth operations still bypass it', async () => {
    const fake = createFakeDatabase();
    await withServer(fake, async baseUrl => {
        for (let attempt = 0; attempt < 50; attempt++) {
            // Each login uses a different account bucket, so only the IP limit can block.
            const isSignup = attempt % 2 === 0;
            const response = await post(baseUrl, isSignup ? signup : {
                type: 'login', user_name: `router-player-${attempt}`,
            });
            assert.equal(response.status, 200);
            assert.deepEqual(response.body, isSignup
                ? { error: 'DUPLICATE_USER', status: 409 } : { error: 'AUTH_FAILED' });
        }
        assert.equal(fake.queries.length, 25);
        const blocked = await post(baseUrl, {
            type: 'login', user_name: 'fresh-account', user_password: signup.user_password,
        });
        assert.equal(blocked.status, 429);
        assert.deepEqual(blocked.body, { error: 'RATE_LIMITED' });
        assert.match(blocked.headers.get('ratelimit-policy') ?? '', /q=50/);
        assert.doesNotMatch(blocked.headers.get('ratelimit-policy') ?? '', /q=20/);
        assert.equal(fake.queries.length, 25);

        const read = await post(baseUrl, { type: 'get_leaderboard' });
        assert.equal(read.status, 200);
        assert.deepEqual(read.body, { success: true, leaderboard: [{ user_name: 'router-player', p4_score: 100 }] });
        const frozen = await post(baseUrl, { type: 'submit_score' });
        assert.equal(frozen.status, 503);
        assert.deepEqual(frozen.body, { error: 'SUBMISSIONS_FROZEN' });
        const unknown = await post(baseUrl, { type: 'unknown' });
        assert.equal(unknown.status, 200);
        assert.deepEqual(unknown.body, { error: 'INVALID_TYPE' });
    });
    assert.equal(fake.queries.length, 26);
});

test('rejected fake persistence reaches the central handler without exposing diagnostics', async context => {
    const fake = createFakeDatabase(new Error('private database host and SQL diagnostic'));
    const logged: unknown[][] = [];
    context.mock.method(console, 'error', (...values: unknown[]) => { logged.push(values); });
    await withServer(fake, async baseUrl => {
        const response = await post(baseUrl, signup);
        assert.equal(response.status, 500);
        assert.deepEqual(response.body, { error: 'SERVER_ERROR' });
        assert.equal(response.headers.get('set-cookie'), null);
    });
    assert.equal(fake.queries.length, 1);
    assert.deepEqual(logged, [['Unhandled request error', { name: 'Error' }]]);
});
