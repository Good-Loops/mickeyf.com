import type { Connect, Plugin } from 'vite';

const publicApiOrigin = 'https://mickeyf-org-j7yuum4tiq-uc.a.run.app';
const allowedPaths = new Set([
    '/api/leaderboards',
    '/api/leaderboards/p4-vega',
    '/api/leaderboards/three-bosses',
]);

/** Public reads only: never forward local credentials, request bodies or cookies. */
export function publicLeaderboardMiddleware(fetchPublic: typeof fetch = fetch): Connect.NextHandleFunction {
    return async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        if (request.method !== 'GET' || !allowedPaths.has(request.url ?? '')) {
            response.statusCode = 404;
            response.end(JSON.stringify({ error: 'NOT_FOUND' }));
            return;
        }

        try {
            const upstream = await fetchPublic(`${publicApiOrigin}${request.url}`, {
                method: 'GET',
                headers: { Accept: 'application/json' },
                credentials: 'omit',
                redirect: 'error',
                signal: AbortSignal.timeout(8_000),
            });
            const body = await upstream.text();
            response.statusCode = upstream.status;
            // Deliberately do not relay Set-Cookie or other upstream headers.
            response.end(body);
        } catch {
            response.statusCode = 502;
            response.end(JSON.stringify({ error: 'PUBLIC_LEADERBOARD_UNAVAILABLE' }));
        }
    };
}

export function publicLeaderboardsPlugin(): Plugin {
    return {
        name: 'public-leaderboard-preview',
        apply: 'serve',
        configureServer(server) {
            server.middlewares.use('/__public-leaderboards', publicLeaderboardMiddleware());
        },
    };
}
