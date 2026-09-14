import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';

/** SSR tests must never replace the dependency cache of a running dev server. */
export async function createViteTestServer(config) {
    const temporaryRoot = path.resolve(tmpdir());
    const cachePrefix = 'mickeyf-vite-test-';
    const cacheDirectory = await mkdtemp(path.join(temporaryRoot, cachePrefix));
    const removeCache = async () => {
        // Only remove this invocation's mkdtemp-owned child, never a configured cache.
        const resolvedCache = path.resolve(cacheDirectory);
        if (path.dirname(resolvedCache) !== temporaryRoot
            || !path.basename(resolvedCache).startsWith(cachePrefix)) {
            throw new Error('Refusing to remove an unexpected Vite test cache directory');
        }
        await rm(resolvedCache, { recursive: true, force: true });
    };

    try {
        const server = await createServer({
            ...config,
            cacheDir: cacheDirectory,
            server: { ...config.server, preTransformRequests: false },
            plugins: [...(config.plugins ?? []), {
                name: 'isolated-ssr-test-cache',
                configResolved(resolved) {
                    // SSR tests need no browser prebundling. Disable it after
                    // plugins such as React have added their dependency includes.
                    for (const environment of Object.values(resolved.environments)) {
                        environment.optimizeDeps.noDiscovery = true;
                        environment.optimizeDeps.include = [];
                    }
                },
            }],
        });
        const closeServer = server.close.bind(server);
        let closePromise;
        server.close = () => {
            closePromise ??= (async () => {
                try {
                    await closeServer();
                } finally {
                    await removeCache();
                }
            })();
            return closePromise;
        };
        return server;
    } catch (error) {
        await removeCache();
        throw error;
    }
}
