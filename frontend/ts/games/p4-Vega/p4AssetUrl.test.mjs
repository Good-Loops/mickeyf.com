import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMAdapter, Loader, Resolver } from 'pixi.js';
import { resolveP4AssetUrl } from './p4AssetUrl.ts';

async function loadThroughPixi(source, baseUrl) {
    const adapter = DOMAdapter.get();
    DOMAdapter.set({ ...adapter, getBaseUrl: () => baseUrl });
    try {
        const resolver = new Resolver();
        resolver.add({ alias: 'sprite', src: resolveP4AssetUrl(source, baseUrl) });
        const loader = new Loader();
        // Exercise Pixi's real URL pipeline without a browser or network request.
        loader.parsers.push({ id: 'capture-url', test: () => true, load: async url => url });
        return await loader.load(resolver.resolve('sprite'));
    } finally {
        DOMAdapter.set(adapter);
    }
}

for (const origin of ['capacitor://localhost', 'https://mickeyf.com', 'http://localhost:5173']) {
    test(`sprite URLs retain their origin and assets directory on ${origin}`, async () => {
        const baseUrl = `${origin}/games/p4-Vega`;
        for (const sprite of ['p4', 'water', 'bhBlue', 'bhRed', 'bhYellow']) {
            const source = `/assets/${sprite}-hash.png`;
            assert.equal(await loadThroughPixi(source, baseUrl), `${origin}${source}`);
        }
    });
}

test('relative and already absolute sprite URLs keep standard URL semantics', async () => {
    const baseUrl = 'capacitor://localhost/games/p4-Vega?test=1';
    assert.equal(await loadThroughPixi('../assets/p4.png?v=2', baseUrl),
        'capacitor://localhost/assets/p4.png?v=2');
    assert.equal(await loadThroughPixi('capacitor://localhost/assets/p4.png', baseUrl),
        'capacitor://localhost/assets/p4.png');
});

test('inlined images remain valid data URLs', async () => {
    const source = 'data:image/png;base64,iVBORw0KGgo=';
    assert.equal(await loadThroughPixi(source, 'capacitor://localhost/'), source);
});
