import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';
import { publicLeaderboardMiddleware } from '../../dev/publicLeaderboards.ts';

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const publicOrigin = 'https://mickeyf-org-j7yuum4tiq-uc.a.run.app';
const allowedPaths = [
    '/api/leaderboards',
    '/api/leaderboards/p4-vega',
    '/api/leaderboards/three-bosses',
];
const catalog = {
    success: true,
    contractVersion: 1,
    games: [
        {
            gameId: 'p4-vega', displayName: 'p4-Vega', rulesVersion: 1,
            primaryMetric: 'score', sortDirection: 'descending',
            labels: { score: 'Score', completionTime: null, rank: null },
            rankState: 'not-applicable', submissionState: 'legacy-only',
        },
        {
            gameId: 'three-bosses', displayName: 'Three Bosses', rulesVersion: 1,
            primaryMetric: 'completionTimeMs', sortDirection: 'ascending',
            labels: { score: 'Score', completionTime: 'Time', rank: 'Rank' },
            rankState: 'ranked', submissionState: 'disabled',
        },
    ],
};

function payloadFor(path) {
    return path.endsWith('/leaderboards') ? catalog : {
        success: true,
        contractVersion: 1,
        gameId: path.split('/').at(-1),
        rulesVersion: 1,
        entries: [],
    };
}

async function invoke(middleware, method, url) {
    const response = {
        statusCode: 200,
        headers: {},
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
        end(body) { this.body = body; },
    };
    await middleware({
        method,
        url,
        headers: { cookie: '__session=local-secret', authorization: 'Bearer local-secret' },
        body: 'local-private-body',
    }, response, () => assert.fail('Reserved public routes must not fall through'));
    return response;
}

test('public middleware allows only the three fixed reads and isolates credentials both ways', async () => {
    const calls = [];
    const middleware = publicLeaderboardMiddleware(async (url, init) => {
        calls.push({ url, init });
        return Response.json(payloadFor(url), {
            headers: { 'Set-Cookie': '__session=upstream-secret', 'X-Upstream-Only': 'private' },
        });
    });

    for (const path of allowedPaths) {
        const response = await invoke(middleware, 'GET', path);
        const { url, init } = calls.at(-1);
        assert.equal(url, `${publicOrigin}${path}`);
        assert.equal(init.method, 'GET');
        assert.equal(init.credentials, 'omit');
        assert.equal(init.redirect, 'error');
        assert.deepEqual(init.headers, { Accept: 'application/json' });
        assert.equal(init.body, undefined);
        assert.ok(init.signal instanceof AbortSignal);
        assert.equal(response.statusCode, 200);
        assert.deepEqual(JSON.parse(response.body), payloadFor(path));
        assert.deepEqual(response.headers, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
        });
    }
    assert.equal(calls.length, 3);
});

test('public middleware rejects mutations, other methods, queries and path variants without fetching', async () => {
    let calls = 0;
    const middleware = publicLeaderboardMiddleware(async () => {
        calls += 1;
        assert.fail('Rejected requests must never reach the public service');
    });
    const rejected = [
        ...allowedPaths.map(path => ['POST', path]),
        ['HEAD', allowedPaths[0]],
        ['DELETE', allowedPaths[1]],
        ['GET', '/api/users'],
        ['GET', '/api/leaderboards/three-bosses/runs'],
        ['GET', '/api/leaderboards/three-bosses/run-tickets'],
        ['GET', '/api/leaderboards?limit=1'],
        ['GET', '/api/leaderboards/'],
        ['GET', '/api/leaderboards/p4%2Dvega'],
        ['GET', '/api/leaderboards/../users'],
        ['GET', 'https://elsewhere.example/api/leaderboards'],
        ['GET', undefined],
    ];

    for (const [method, path] of rejected) {
        const response = await invoke(middleware, method, path);
        assert.equal(response.statusCode, 404, `${method} ${path}`);
        assert.deepEqual(JSON.parse(response.body), { error: 'NOT_FOUND' });
    }
    assert.equal(calls, 0);
});

test('public middleware preserves upstream HTTP errors and sanitizes transport/body failures', async () => {
    const limited = await invoke(publicLeaderboardMiddleware(async () =>
        Response.json({ success: false, error: 'RATE_LIMITED' }, { status: 429 })
    ), 'GET', allowedPaths[0]);
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(JSON.parse(limited.body), { success: false, error: 'RATE_LIMITED' });

    for (const fetchPublic of [
        async () => { throw new Error('private upstream failure'); },
        async () => ({ status: 200, text: async () => { throw new Error('private body failure'); } }),
    ]) {
        const failed = await invoke(publicLeaderboardMiddleware(fetchPublic), 'GET', allowedPaths[0]);
        assert.equal(failed.statusCode, 502);
        assert.deepEqual(JSON.parse(failed.body), { error: 'PUBLIC_LEADERBOARD_UNAVAILABLE' });
    }
});

const testCacheDirectories = new Set();

for (const development of [true, false]) {
    test(`${development ? 'DEV' : 'production'} display routing preserves the independent gameplay service`, async (t) => {
        const calls = [];
        t.mock.method(globalThis, 'fetch', async (url, init) => {
            calls.push({ url, init });
            return Response.json(payloadFor(url));
        });
        const server = await createViteTestServer({
            root: frontendRoot,
            configFile: `${frontendRoot}/vite.config.ts`,
            mode: development ? 'development' : 'production',
            appType: 'custom',
            logLevel: 'silent',
            define: {
                'import.meta.env.DEV': JSON.stringify(development),
                'import.meta.env.VITE_DEV_API_URL': JSON.stringify('http://local-api.test'),
            },
            server: { middlewareMode: true, watch: null, hmr: false },
        });
        try {
            const cacheDirectory = path.resolve(server.config.cacheDir);
            assert.notEqual(cacheDirectory, path.resolve(frontendRoot, 'node_modules/.vite'));
            assert.equal(testCacheDirectories.has(cacheDirectory), false);
            testCacheDirectories.add(cacheDirectory);
            assert.equal(server.config.environments.client.optimizeDeps.noDiscovery, true);
            assert.deepEqual(server.config.environments.client.optimizeDeps.include, []);
            assert.equal(server.config.server.preTransformRequests, false);
            const display = await server.ssrLoadModule('/ts/services/leaderboardDisplayService.ts');
            assert.deepEqual(await display.getLeaderboardCatalog(), catalog);
            for (const gameId of ['p4-vega', 'three-bosses']) {
                assert.deepEqual(await display.getGameLeaderboard(gameId), payloadFor(`/api/leaderboards/${gameId}`));
            }
            assert.deepEqual(calls.map(call => call.url), allowedPaths.map(path =>
                `${development ? '/__public-leaderboards' : ''}${path}`
            ));
            assert.ok(calls.every(({ init }) => init.method === 'GET'
                && init.credentials === (development ? 'omit' : 'include')));
            assert.equal(display.leaderboardSourceNotice !== null, development);
            assert.equal(server.config.plugins.some(plugin => plugin.name === 'public-leaderboard-preview'), development);

            const gameplay = await server.ssrLoadModule('/ts/services/leaderboardService.ts');
            await gameplay.getLeaderboardCatalog();
            assert.equal(calls.at(-1).url, `${development ? 'http://local-api.test' : ''}/api/leaderboards`);
            assert.equal(calls.at(-1).init.credentials, 'include');
            assert.equal(typeof gameplay.issueThreeBossesRunTicket, 'function');
            assert.equal(typeof gameplay.submitThreeBossesRun, 'function');
            assert.equal(display.issueThreeBossesRunTicket, undefined);
            assert.equal(display.submitThreeBossesRun, undefined);
        } finally {
            await server.close();
            await assert.rejects(access(server.config.cacheDir), { code: 'ENOENT' });
        }
    });
}
