import assert from 'node:assert/strict';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { Pool } from 'mysql2/promise';
import { notFoundHandler } from '../middleware/errorHandling';
import { leaderboardRoutesContract } from './leaderboardRouter.contract';
import { createLeaderboardRouter } from './leaderboardRouter';

type QueryCall = Readonly<{
    sql: string;
    timeout: number | undefined;
    values: unknown[] | undefined;
}>;

function createFakeDatabase(queryError?: Error) {
    const queries: QueryCall[] = [];
    const database = {
        async query(
            options: { sql: string; timeout?: number },
            values?: unknown[]
        ) {
            queries.push({
                sql: options.sql.replace(/\s+/g, ' ').trim(),
                timeout: options.timeout,
                values,
            });
            if (queryError) throw queryError;
            return [[
                { userName: 'historical-player', score: 1_200, internalId: 91 },
                { userName: 'current-player', score: 990, internalId: 42 },
            ], []];
        },
    } as unknown as Pick<Pool, 'query'>;
    return { database, queries };
}

async function withLeaderboardServer(
    database: Pick<Pool, 'query'>,
    run: (origin: string) => Promise<void>
) {
    const app = express();
    app.use('/api/leaderboards', createLeaderboardRouter(database));
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

async function requestJson(origin: string, path: string, method = 'GET') {
    const response = await fetch(`${origin}${path}`, { method });
    return {
        status: response.status,
        body: await response.json(),
    };
}

test('publishes the two additive public read route contracts', () => {
    assert.deepEqual(
        leaderboardRoutesContract.routes.map(({ id, method, path, auth }) => ({
            id,
            method,
            path,
            auth,
        })),
        [
            {
                id: 'leaderboards.catalog',
                method: 'GET',
                path: '/',
                auth: 'public',
            },
            {
                id: 'leaderboards.game',
                method: 'GET',
                path: '/:gameId',
                auth: 'public',
            },
        ]
    );
});

test('serves the exact catalog and game DTOs without enabling Three Bosses writes', async () => {
    const fake = createFakeDatabase();

    await withLeaderboardServer(fake.database, async (origin) => {
        assert.deepEqual(await requestJson(origin, '/api/leaderboards'), {
            status: 200,
            body: {
                success: true,
                contractVersion: 1,
                games: [
                    {
                        gameId: 'p4-vega',
                        displayName: 'p4-Vega',
                        rulesVersion: 1,
                        primaryMetric: 'score',
                        sortDirection: 'descending',
                        labels: {
                            score: 'Score',
                            completionTime: null,
                            rank: null,
                        },
                        rankState: 'not-applicable',
                        submissionState: 'legacy-only',
                    },
                    {
                        gameId: 'three-bosses',
                        displayName: 'Three Bosses',
                        rulesVersion: 1,
                        primaryMetric: 'completionTimeMs',
                        sortDirection: 'ascending',
                        labels: {
                            score: 'Score',
                            completionTime: 'Time',
                            rank: 'Rank',
                        },
                        rankState: 'unranked',
                        submissionState: 'disabled',
                    },
                ],
            },
        });
        assert.equal(fake.queries.length, 0);

        assert.deepEqual(
            await requestJson(origin, '/api/leaderboards/three-bosses'),
            {
                status: 200,
                body: {
                    success: true,
                    contractVersion: 1,
                    gameId: 'three-bosses',
                    rulesVersion: 1,
                    entries: [],
                },
            }
        );
        assert.equal(fake.queries.length, 0);

        assert.deepEqual(
            await requestJson(
                origin,
                '/api/leaderboards/p4-vega?limit=100&sort=user_id&rulesVersion=2'
            ),
            {
                status: 200,
                body: {
                    success: true,
                    contractVersion: 1,
                    gameId: 'p4-vega',
                    rulesVersion: 1,
                    entries: [
                        { position: 1, userName: 'historical-player', score: 1_200 },
                        { position: 2, userName: 'current-player', score: 990 },
                    ],
                },
            }
        );
        assert.equal(fake.queries.length, 1);
        assert.deepEqual(fake.queries[0].values, ['p4-vega', 1]);

        for (const gameId of [
            'P4-Vega',
            'toString',
            "p4-vega' OR 1=1",
        ]) {
            assert.deepEqual(
                await requestJson(
                    origin,
                    `/api/leaderboards/${encodeURIComponent(gameId)}`
                ),
                {
                    status: 404,
                    body: {
                        success: false,
                        contractVersion: 1,
                        error: 'UNKNOWN_GAME',
                    },
                }
            );
        }
        assert.deepEqual(
            await requestJson(origin, '/api/leaderboards/%'),
            {
                status: 404,
                body: {
                    success: false,
                    contractVersion: 1,
                    error: 'UNKNOWN_GAME',
                },
            }
        );
        assert.equal(fake.queries.length, 1);

        assert.deepEqual(
            await requestJson(
                origin,
                '/api/leaderboards/three-bosses/runs',
                'POST'
            ),
            { status: 404, body: { error: 'NOT_FOUND' } }
        );
        assert.equal(fake.queries.length, 1);
    });
});

test('generic database failures use the versioned error without leaking details', async () => {
    const databaseError = new URIError('secret internal URI diagnostic');
    const fake = createFakeDatabase(databaseError);
    const logged: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...values: unknown[]) => {
        logged.push(values);
    };

    try {
        await withLeaderboardServer(fake.database, async (origin) => {
            assert.deepEqual(
                await requestJson(origin, '/api/leaderboards/p4-vega'),
                {
                    status: 500,
                    body: {
                        success: false,
                        contractVersion: 1,
                        error: 'SERVER_ERROR',
                    },
                }
            );
        });
    } finally {
        console.error = originalConsoleError;
    }

    assert.equal(fake.queries.length, 1);
    assert.deepEqual(logged, [[
        'Unhandled leaderboard request error',
        { name: 'URIError' },
    ]]);
    assert.equal(JSON.stringify(logged).includes(databaseError.message), false);
});
