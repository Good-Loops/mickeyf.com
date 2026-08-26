import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import cookieParser from 'cookie-parser';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Pool, PoolConnection } from 'mysql2/promise';
import { notFoundHandler } from '../middleware/errorHandling';
import { createThreeBossesPayloadFingerprint } from '../leaderboards/threeBossesRunRepository';
import { createLeaderboardRouter } from './leaderboardRouter';

const sessionSecret = 'three-bosses-router-security-test-secret';
const allowedOrigins = Object.freeze([
    'https://mickeyf.com',
    'http://localhost:5173',
]);
const runId = '123e4567-e89b-42d3-a456-426614174000';
const validRun = Object.freeze({
    contractVersion: 1,
    rulesVersion: 1,
    runId,
    completionTimeMs: 50_000,
});

type RequestOptions = Readonly<{
    token?: string;
    cookie?: string;
    origin?: string;
    contentType?: string;
    body?: unknown;
}>;

function signedSessionCookie(token: string): string {
    const signature = createHmac('sha256', sessionSecret)
        .update(token)
        .digest('base64')
        .replace(/=+$/, '');
    return `session=${encodeURIComponent(`s:${token}.${signature}`)}`;
}

function createReplayDatabase() {
    let connectionAcquisitions = 0;
    const events: string[] = [];
    const database = {
        async query() {
            throw new Error('submission security tests must not use pool.query');
        },
        async getConnection() {
            connectionAcquisitions += 1;
            const connection = {
                async beginTransaction() {
                    events.push('begin');
                },
                async query(options: { sql: string }) {
                    const sql = options.sql.replace(/\s+/g, ' ').trim();
                    events.push(sql);
                    if (sql.includes('FROM users')) {
                        return [[{ user_id: 42 }], []];
                    }
                    if (sql.includes('FROM game_runs')) {
                        return [[{
                            rulesVersion: 1,
                            score: 2_000,
                            completionTimeMs: 50_000,
                            payloadFingerprint: createThreeBossesPayloadFingerprint(
                                42,
                                runId,
                                50_000
                            ),
                            personalBest: 1,
                        }], []];
                    }
                    throw new Error(`Unexpected security-test query: ${sql}`);
                },
                async commit() {
                    events.push('commit');
                },
                async rollback() {
                    events.push('rollback');
                },
                release() {
                    events.push('release');
                },
                destroy() {
                    events.push('destroy');
                },
            } as unknown as PoolConnection;
            return connection;
        },
    } as unknown as Pick<Pool, 'getConnection' | 'query'>;

    return {
        database,
        events,
        get connectionAcquisitions() {
            return connectionAcquisitions;
        },
    };
}

async function withServer(
    database: Pick<Pool, 'getConnection' | 'query'>,
    enabled: boolean,
    run: (baseUrl: string) => Promise<void>
) {
    const app = express();
    app.use(cookieParser(sessionSecret));
    app.use('/api/leaderboards', createLeaderboardRouter(database, {
        sessionSecret,
        allowedMutationOrigins: allowedOrigins,
        threeBossesRunSubmissionsEnabled: enabled,
    }));
    app.use(notFoundHandler);

    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    try {
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
}

async function requestRawJson(
    baseUrl: string,
    body: string,
    headers: Record<string, string> = {}
) {
    const response = await fetch(
        `${baseUrl}/api/leaderboards/three-bosses/runs`,
        {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body,
        }
    );
    return { status: response.status, body: await response.json() };
}

async function requestJson(
    baseUrl: string,
    path: string,
    options: RequestOptions = {}
) {
    const headers: Record<string, string> = {};
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.cookie) headers.cookie = options.cookie;
    if (options.origin) headers.origin = options.origin;
    if (options.contentType) headers['content-type'] = options.contentType;
    const response = await fetch(`${baseUrl}${path}`, {
        method: options.body === undefined ? 'GET' : 'POST',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return { status: response.status, body: await response.json() };
}

test('disabled submissions always fail closed before auth, the IP limiter, or database', async () => {
    const fake = createReplayDatabase();
    const token = jwt.sign({ user_id: 42, user_name: 'player' }, sessionSecret, {
        algorithm: 'HS256',
        expiresIn: '5m',
    });

    await withServer(fake.database, false, async (baseUrl) => {
        for (let index = 0; index < 35; index += 1) {
            assert.deepEqual(await requestJson(
                baseUrl,
                '/api/leaderboards/three-bosses/runs',
                {
                    token: index % 2 === 0 ? token : undefined,
                    contentType: 'application/json',
                    body: index % 3 === 0 ? validRun : { malformed: true },
                }
            ), {
                status: 403,
                body: {
                    success: false,
                    contractVersion: 1,
                    error: 'SUBMISSION_DISABLED',
                },
            });
        }
        assert.deepEqual(await requestRawJson(baseUrl, '{malformed-json'), {
            status: 403,
            body: {
                success: false,
                contractVersion: 1,
                error: 'SUBMISSION_DISABLED',
            },
        });
    });

    assert.equal(fake.connectionAcquisitions, 0);
    assert.deepEqual(fake.events, []);
});

test('enabled submissions enforce auth, Origin, JSON, and exact payload before database', async () => {
    const fake = createReplayDatabase();
    const token = jwt.sign({ user_id: 42, user_name: 'player' }, sessionSecret, {
        algorithm: 'HS256',
        expiresIn: '5m',
    });
    const cookie = signedSessionCookie(token);
    const expectedReplay = {
        status: 200,
        body: {
            success: true,
            contractVersion: 1,
            gameId: 'three-bosses',
            rulesVersion: 1,
            runId,
            replayed: true,
            personalBest: true,
            result: {
                score: 2_000,
                completionTimeMs: 50_000,
                rank: 'UNRANKED',
            },
        },
    };

    await withServer(fake.database, true, async (baseUrl) => {
        const path = '/api/leaderboards/three-bosses/runs';
        const json = 'application/json';

        assert.deepEqual(await requestJson(baseUrl, path, {
            contentType: json,
            body: validRun,
        }), {
            status: 401,
            body: { success: false, contractVersion: 1, error: 'UNAUTHORIZED' },
        });

        assert.deepEqual(await requestJson(baseUrl, path, {
            token,
            contentType: json,
            body: validRun,
        }), expectedReplay);
        for (const origin of allowedOrigins) {
            assert.deepEqual(await requestJson(baseUrl, path, {
                cookie,
                origin,
                contentType: json,
                body: validRun,
            }), expectedReplay);
        }

        for (const options of [
            { cookie, contentType: json, body: validRun },
            {
                cookie,
                origin: 'https://evil.example',
                contentType: json,
                body: validRun,
            },
            {
                token,
                origin: 'https://evil.example',
                contentType: json,
                body: validRun,
            },
        ]) {
            assert.deepEqual(await requestJson(baseUrl, path, options), {
                status: 401,
                body: { success: false, contractVersion: 1, error: 'UNAUTHORIZED' },
            });
        }

        for (const options of [
            { token, contentType: 'text/plain', body: validRun },
            { token, contentType: json, body: { ...validRun, score: 2_000 } },
            { token, contentType: json, body: { ...validRun, completionTimeMs: 0 } },
        ]) {
            assert.deepEqual(await requestJson(baseUrl, path, options), {
                status: 400,
                body: { success: false, contractVersion: 1, error: 'INVALID_RUN' },
            });
        }

        assert.deepEqual(await requestJson(baseUrl, path, {
            token,
            contentType: json,
            body: { ...validRun, contractVersion: 2 },
        }), {
            status: 400,
            body: {
                success: false,
                contractVersion: 1,
                error: 'UNSUPPORTED_CONTRACT_VERSION',
            },
        });
        assert.deepEqual(await requestJson(baseUrl, path, {
            token,
            contentType: json,
            body: { ...validRun, rulesVersion: 2 },
        }), {
            status: 400,
            body: {
                success: false,
                contractVersion: 1,
                error: 'UNSUPPORTED_RULES_VERSION',
            },
        });

        assert.deepEqual(await requestRawJson(baseUrl, '{malformed-json', {
            authorization: `Bearer ${token}`,
        }), {
            status: 400,
            body: { success: false, contractVersion: 1, error: 'INVALID_RUN' },
        });

        const catalog = await requestJson(baseUrl, '/api/leaderboards');
        assert.equal(
            (catalog.body as { games: Array<{ gameId: string; submissionState: string }> })
                .games.find(({ gameId }) => gameId === 'three-bosses')
                ?.submissionState,
            'enabled'
        );
    });

    assert.equal(fake.connectionAcquisitions, 3);
    assert.equal(fake.events.filter((event) => event === 'commit').length, 3);
    assert.equal(fake.events.filter((event) => event === 'release').length, 3);
});

test('enabled submissions apply the dedicated 30-request per-instance IP ceiling', async () => {
    const fake = createReplayDatabase();

    await withServer(fake.database, true, async (baseUrl) => {
        const path = '/api/leaderboards/three-bosses/runs';
        for (let index = 0; index < 30; index += 1) {
            const response = await requestJson(baseUrl, path, {
                contentType: 'application/json',
                body: validRun,
            });
            assert.equal(response.status, 401);
        }

        assert.deepEqual(await requestJson(baseUrl, path, {
            contentType: 'application/json',
            body: validRun,
        }), {
            status: 429,
            body: { success: false, contractVersion: 1, error: 'RATE_LIMITED' },
        });
    });

    assert.equal(fake.connectionAcquisitions, 0);
});
