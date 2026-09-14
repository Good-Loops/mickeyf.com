import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { createServer } from 'vite';

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const viteServer = await createServer({
    root: frontendRoot,
    configFile: `${frontendRoot}/vite.config.ts`,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
});
after(() => viteServer.close());
const { default: RouteContentBoundary } = await viteServer.ssrLoadModule('/ts/components/RouteContentBoundary.tsx');
const { default: NotFound } = await viteServer.ssrLoadModule('/ts/pages/NotFound.tsx');

test('loaded route content gains no wrapper that could break direct-child layout selectors', () => {
    const page = React.createElement('section', { className: 'p4-vega' }, 'Game');
    const markup = renderToStaticMarkup(React.createElement(RouteContentBoundary, null, page));
    assert.equal(markup, renderToStaticMarkup(page));
});

test('a pending lazy route exposes an accessible loading status', () => {
    const PendingPage = React.lazy(() => new Promise(() => {}));
    const markup = renderToStaticMarkup(
        React.createElement(RouteContentBoundary, null, React.createElement(PendingPage)),
    );
    assert.match(markup, /class="page-status page-status--loading" role="status"/);
    assert.match(markup, /A new world awaits/);
    assert.match(markup, /Loading page/);
    assert.doesNotMatch(markup, /<button|<a /);
});

test('failure state offers recovery actions without automatically reloading', (context) => {
    let reloadCount = 0;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { reload: () => { reloadCount += 1; } } },
    });
    context.after(() => {
        if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
        else delete globalThis.window;
    });

    // React's server renderer does not catch errors; exercise the boundary's derived failure state directly.
    const boundary = new RouteContentBoundary({ children: 'Page content' });
    boundary.state = RouteContentBoundary.getDerivedStateFromError(new Error('Chunk unavailable'));
    const failure = boundary.render();
    const markup = renderToStaticMarkup(React.createElement(MemoryRouter, null, failure));
    assert.match(markup, /role="alert"/);
    assert.match(markup, /This page could not load\./);
    assert.match(markup, /That world is out of reach/);
    assert.match(markup, /<button[^>]*>Reload page<\/button>/);
    assert.match(markup, /href="\/"/);
    assert.doesNotMatch(markup, /Page content/);
    assert.equal(reloadCount, 0);

    assert.deepEqual(new RouteContentBoundary({ children: 'Next route' }).state, { failed: false });
});

test('the 404 route has a labelled heading and explicit home and games links', () => {
    const markup = renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(NotFound)));
    assert.match(markup, /class="page-status page-status--not-found"/);
    const [, titleId] = markup.match(/aria-labelledby="([^"]+)"/);
    assert.ok(markup.includes(`<h1 class="page-status__title" id="${titleId}">A little lost in space?</h1>`));
    assert.match(markup, /SIGNAL LOST · 404/);
    assert.match(markup, /href="\/"/);
    assert.match(markup, /href="\/games"/);
    assert.doesNotMatch(markup, /role="alert"|role="status"|<button/);
    assert.equal((markup.match(/class="page-status__digit"/g) ?? []).length, 2);
});
