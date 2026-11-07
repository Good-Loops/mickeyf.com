import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

test('route policy resets in layout before destination fullscreen effects and on disposal', async () => {
    const key = '__presentationHook', previous = Object.getOwnPropertyDescriptor(globalThis, key);
    const fixture = { layouts: [], resets: 0 };
    Object.defineProperty(globalThis, key, { configurable: true, value: fixture });
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const server = await createViteTestServer({ root, configFile: `${root}/vite.config.ts`, appType: 'custom',
        logLevel: 'silent', server: { middlewareMode: true }, ssr: { noExternal: [/^react$/] }, plugins: [{
            name: 'presentation-hook-fixture', enforce: 'pre',
            resolveId(source) {
                if (source === 'react') return '\0presentation-react';
                if (source.endsWith('/services/nativePresentation') || source === '@/services/nativePresentation') return '\0presentation-service';
            },
            load(id) {
                if (id === '\0presentation-react') return `export const useLayoutEffect = (effect, dependencies) => globalThis.${key}.layouts.push({ effect, dependencies });`;
                if (id === '\0presentation-service') return `export const nativePresentation = { reset() { globalThis.${key}.resets++; } };`;
            },
        }] });
    try {
        const { useNativePresentation } = await server.ssrLoadModule('/ts/hooks/useNativePresentation.ts');
        useNativePresentation('/games/p4-Vega');
        assert.deepEqual(fixture.layouts[0].dependencies, ['/games/p4-Vega']);
        assert.equal(fixture.resets, 0);
        const dispose = fixture.layouts[0].effect();
        assert.equal(fixture.resets, 1, 'portrait reset happens during layout, before child passive effects');
        dispose(); assert.equal(fixture.resets, 2);
        useNativePresentation('/login'); fixture.layouts[1].effect();
        assert.deepEqual(fixture.layouts[1].dependencies, ['/login']);
        assert.equal(fixture.resets, 3);
    } finally {
        await server.close();
        if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key];
    }
});
