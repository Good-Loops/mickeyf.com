import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getPageMetadata } from '../config/pageMetadata.ts';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureKey = '__pageMetadataHooks';
const server = await createViteTestServer({
    root, configFile: `${root}/vite.config.ts`, appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true }, ssr: { noExternal: [/^react$/, /^react-router-dom$/, /^@capacitor\/core$/] },
    plugins: [{
        name: 'page-metadata-hooks', enforce: 'pre',
        resolveId(source) {
            if (['react', 'react-router-dom', '@capacitor/core'].includes(source)) return `\0metadata-${source}`;
        },
        load(id) {
            if (id === '\0metadata-react') return `export const useEffect = effect => globalThis.${fixtureKey}.effects.push(effect);`;
            if (id === '\0metadata-react-router-dom') return `export const useLocation = () => ({ pathname: globalThis.${fixtureKey}.pathname });`;
            if (id === '\0metadata-@capacitor/core') return `export const Capacitor = { isNativePlatform: () => globalThis.${fixtureKey}.native };`;
        },
    }],
});
after(() => server.close());
const { default: PageMetadata } = await server.ssrLoadModule('/ts/components/PageMetadata.tsx');

test('sitemap contains canonical public routes and excludes gated and account pages', async () => {
    const xml = await readFile(new URL('../../public/sitemap.xml', import.meta.url), 'utf8');
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(match => match[1]);
    assert.ok(urls.length > 0);
    assert.equal(new Set(urls).size, urls.length);
    for (const url of urls) {
        const parsed = new URL(url);
        assert.equal(parsed.origin, 'https://mickeyf.com');
        const metadata = getPageMetadata(parsed.pathname);
        assert.equal(metadata.canonical, url);
        assert.equal(metadata.robots, 'index, follow');
    }
    assert.ok(!xml.includes('/games/three-bosses'));
    assert.ok(!xml.includes('/parent-accounts'));
    const robots = await readFile(new URL('../../public/robots.txt', import.meta.url), 'utf8');
    assert.match(robots, /^Sitemap: https:\/\/mickeyf\.com\/sitemap\.xml$/mu);
});

test('public canonical URLs normalize query, fragment, case and trailing slash without trusting an external origin', () => {
    const cases = [
        ['/', 'https://mickeyf.com/'],
        ['/?utm_source=github#games', 'https://mickeyf.com/'],
        ['/games/', 'https://mickeyf.com/games'],
        ['/games/p4-vega/?source=search', 'https://mickeyf.com/games/p4-Vega'],
        ['/CONNECT/#github', 'https://mickeyf.com/connect'],
        ['/animations/dancing-circles', 'https://mickeyf.com/animations/dancing-circles'],
        ['/animations/dancing-fractals', 'https://mickeyf.com/animations/dancing-fractals'],
        ['/privacy', 'https://mickeyf.com/privacy'],
        ['/leaderboards', 'https://mickeyf.com/leaderboards'],
        ['/leaderboards/p4-vega', 'https://mickeyf.com/leaderboards/p4-vega'],
        ['/Leaderboards/p4-vega', 'https://mickeyf.com/leaderboards/p4-vega'],
        ['/login', 'https://mickeyf.com/login'],
        ['/signup', 'https://mickeyf.com/signup'],
        ['/licenses', 'https://mickeyf.com/licenses'],
        ['/animations/other', 'https://mickeyf.com/animations'],
    ];
    for (const [location, canonical] of cases) {
        const metadata = getPageMetadata(location);
        assert.equal(metadata.canonical, canonical);
        assert.equal(metadata.robots, 'index, follow');
    }
    for (const location of ['https://elsewhere.example/connect', '//elsewhere.example/connect']) {
        assert.equal(getPageMetadata(location).canonical, undefined);
    }
});

test('private, unknown and disabled routes stay unindexed without a public canonical', () => {
    for (const path of ['/account', '/parent-accounts', '/games/three-bosses', '/missing']) {
        const metadata = getPageMetadata(path);
        assert.equal(metadata.robots, 'noindex, follow', path);
        assert.equal(metadata.canonical, undefined, path);
    }
    assert.equal(getPageMetadata('/games/three-bosses', true).canonical, 'https://mickeyf.com/games/three-bosses');
    assert.equal(getPageMetadata('/games/three-bosses', true).robots, 'index, follow');
});

function mountFixture(t, native = false) {
    const nodes = [];
    const querySelector = selector => {
        const [, tag, attribute, value] = /^(meta|link)\[(name|property|rel)="([^"]+)"\]$/u.exec(selector);
        return nodes.find(node => node.tag === tag && node[attribute] === value) ?? null;
    };
    const page = {
        title: 'Initial title',
        head: { querySelector, append: node => nodes.push(node) },
        createElement: tag => ({
            tag,
            setAttribute(name, value) { this[name] = value; },
            remove() { nodes.splice(nodes.indexOf(this), 1); },
        }),
    };
    const hooks = { effects: [], pathname: '/', native };
    const globals = { [fixtureKey]: hooks, document: page };
    const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    return {
        page, nodes, querySelector,
        navigate(pathname) {
            hooks.pathname = pathname;
            assert.equal(PageMetadata({ threeBossesAvailable: false }), null);
            hooks.effects.splice(0).forEach(effect => effect());
        },
    };
}

test('SPA navigation removes stale canonical URLs and resets noindex when returning to a public page', t => {
    const fixture = mountFixture(t);
    const { page, nodes, navigate, querySelector } = fixture;
    navigate('/');
    const initialTagCount = nodes.length;
    const description = querySelector('meta[name="description"]');
    assert.match(description.content, /interactive platform/u);
    assert.match(description.content, /Michel Fingergut of Good-Loops/u);
    assert.equal(querySelector('link[rel="canonical"]').href, 'https://mickeyf.com/');

    for (const path of ['/account', '/missing']) {
        navigate(path);
        assert.equal(querySelector('meta[name="robots"]').content, 'noindex, follow');
        assert.equal(querySelector('link[rel="canonical"]'), null);
        assert.equal(querySelector('meta[property="og:url"]'), null);
        navigate('/connect/');
        assert.equal(querySelector('meta[name="robots"]').content, 'index, follow');
        assert.equal(querySelector('link[rel="canonical"]').href, 'https://mickeyf.com/connect');
        assert.equal(querySelector('meta[property="og:url"]').content, 'https://mickeyf.com/connect');
        assert.equal(querySelector('meta[name="description"]'), description, 'existing entry-page tags are reused');
        assert.equal(page.title, 'Ludolume');
        assert.equal(querySelector('meta[property="og:title"]').content, getPageMetadata('/connect/').title);
        assert.equal(querySelector('meta[name="twitter:title"]').content, getPageMetadata('/connect/').title);
        assert.equal(nodes.length, initialTagCount, 'navigation must not accumulate duplicate head tags');
    }
});

test('native Capacitor navigation leaves document metadata unchanged', t => {
    const { page, nodes, navigate } = mountFixture(t, true);
    navigate('/connect');
    assert.equal(page.title, 'Initial title');
    assert.deepEqual(nodes, []);
});
