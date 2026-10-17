import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../public/provider-signin-preload.js', import.meta.url), 'utf8');
function fixture({ pathname = '/login', protocol = 'https:', disabled = false, native = false } = {}) {
    const links = [];
    const document = { currentScript: { dataset: { googleStartup: disabled ? 'disabled' : 'enabled' } },
        createElement: () => ({ dataset: {} }),
        head: { appendChild: link => links.push(link),
            querySelector: selector => links.find(link => selector.includes(`"${link.dataset.googleSigninPreload}"`)) },
    };
    const window = { location: { pathname, protocol }, Capacitor: { isNativePlatform: () => native } };
    const run = () => runInNewContext(source, { window, document });
    return { links, run };
}

test('the early auth-page bootstrap only preloads exact public Google resources once, without executing SDK code', () => {
    for (const pathname of ['/login', '/signup', '/login/']) {
        const f = fixture({ pathname }); f.run(); f.run();
        assert.equal(f.links.length, 2);
        assert.deepEqual(f.links.map(link => [link.rel, link.as, link.href]), [
            ['preload', 'script', 'https://accounts.google.com/gsi/client?hl=en'],
            ['preload', 'style', 'https://accounts.google.com/gsi/style'],
        ]);
    }
});

test('early Google resource hints stay off other routes, legacy preview and native origins', () => {
    for (const options of [{ pathname: '/' }, { pathname: '/privacy' }, { pathname: '/login/extra' },
        { disabled: true }, { protocol: 'capacitor:' }, { protocol: 'file:' }, { native: true }]) {
        const f = fixture(options); f.run(); assert.equal(f.links.length, 0);
    }
});
