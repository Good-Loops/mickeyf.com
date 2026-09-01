import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { createServer } from 'vite';

const frontendRoot = fileURLToPath(new URL('../../../', import.meta.url));
const viteServer = await createServer({
    root: frontendRoot,
    configFile: `${frontendRoot}/vite.config.ts`,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
});

after(async () => {
    await viteServer.close();
});

const { GamesView } = await viteServer.ssrLoadModule('/ts/pages/Games.tsx');
const {
    ThreeBossesAvailabilityGate,
    ThreeBossesDesktopOnly,
} = await viteServer.ssrLoadModule(
    '/ts/pages/games/ThreeBosses.tsx',
);

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

const withBrowserNavigator = (browserNavigator, render) => {
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: browserNavigator,
    });

    try {
        return render();
    } finally {
        if (originalNavigator === undefined) {
            delete globalThis.navigator;
        } else {
            Object.defineProperty(globalThis, 'navigator', originalNavigator);
        }
    }
};

const renderGames = (threeBossesAvailable) => renderToStaticMarkup(
    React.createElement(
        MemoryRouter,
        null,
        React.createElement(GamesView, { threeBossesAvailable }),
    ),
);

test('the Games hub exposes Three Bosses only when the current browser supports it', () => {
    const desktopHtml = renderGames(true);
    const mobileHtml = renderGames(false);

    assert.match(desktopHtml, /Three Bosses/);
    assert.match(desktopHtml, /\/games\/three-bosses/);
    assert.doesNotMatch(mobileHtml, /Three Bosses/);
    assert.doesNotMatch(mobileHtml, /\/games\/three-bosses/);
    assert.match(mobileHtml, /p4-Vega/);
});

test('the mobile direct-route surface does not render a Unity canvas', () => {
    const html = renderToStaticMarkup(
        React.createElement(ThreeBossesDesktopOnly),
    );

    assert.match(html, /currently available on desktop only/);
    assert.doesNotMatch(html, /<canvas/);
});

test('the route gate selects the desktop-only surface from the current mobile browser identity', () => {
    const html = withBrowserNavigator({
        maxTouchPoints: 0,
        userAgent: 'Mozilla/5.0 (Linux; Android 15)',
        userAgentData: { mobile: true },
    }, () => renderToStaticMarkup(React.createElement(ThreeBossesAvailabilityGate)));

    assert.match(html, /currently available on desktop only/);
    assert.doesNotMatch(html, /<canvas/);
    assert.doesNotMatch(html, /Local WebGL playability prototype/);
});
