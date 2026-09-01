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
    readThreeBossesSubmissionGate,
    ThreeBossesAvailabilityGate,
    ThreeBossesDesktopOnly,
} = await viteServer.ssrLoadModule(
    '/ts/pages/games/ThreeBosses.tsx',
);
const { default: ScoreSubmissionNotice } = await viteServer.ssrLoadModule(
    '/ts/components/ScoreSubmissionNotice.tsx',
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

test('signed-out players are told to authenticate before starting a ranked run', () => {
    const signedOutHtml = renderToStaticMarkup(
        React.createElement(
            MemoryRouter,
            null,
            React.createElement(ScoreSubmissionNotice, {
                isAuthenticated: false,
                loading: false,
            }),
        ),
    );
    const signedInHtml = renderToStaticMarkup(
        React.createElement(
            MemoryRouter,
            null,
            React.createElement(ScoreSubmissionNotice, {
                isAuthenticated: true,
                loading: false,
            }),
        ),
    );
    const loadingHtml = renderToStaticMarkup(
        React.createElement(
            MemoryRouter,
            null,
            React.createElement(ScoreSubmissionNotice, {
                isAuthenticated: false,
                loading: true,
            }),
        ),
    );

    assert.match(signedOutHtml, /Log in/);
    assert.match(signedOutHtml, /sign up/);
    assert.match(signedOutHtml, /before starting a run to submit scores/);
    assert.match(signedOutHtml, /href="\/login"/);
    assert.match(signedOutHtml, /href="\/signup"/);
    assert.match(signedOutHtml, /role="status"/);
    assert.equal(signedInHtml, '');
    assert.equal(loadingHtml, '');
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

test('the submission gate retries transient catalog failures before enabling ranked runs', async () => {
    const controller = new AbortController();
    let attempts = 0;

    const enabled = await readThreeBossesSubmissionGate(
        controller.signal,
        async () => {
            attempts += 1;
            if (attempts < 3) throw new Error('temporary catalog failure');

            return {
                games: [{
                    gameId: 'three-bosses',
                    displayName: 'Three Bosses',
                    rulesVersion: 1,
                    primaryMetric: 'completionTimeMs',
                    sortDirection: 'ascending',
                    labels: { score: 'Score', completionTime: 'Time', rank: 'Rank' },
                    rankState: 'ranked',
                    submissionState: 'enabled',
                }],
            };
        },
        0,
    );

    assert.equal(enabled, true);
    assert.equal(attempts, 3);
});

test('the submission-gate retry stops promptly when the player lifecycle ends', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const pending = readThreeBossesSubmissionGate(
        controller.signal,
        async () => {
            attempts += 1;
            throw new Error('temporary catalog failure');
        },
        60_000,
    );

    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    assert.equal(await pending, false);
    assert.equal(attempts, 1);
});

test('the submission gate remains fail-closed after its bounded retry window', async () => {
    const controller = new AbortController();
    let attempts = 0;

    const enabled = await readThreeBossesSubmissionGate(
        controller.signal,
        async () => {
            attempts += 1;
            throw new Error('persistent catalog failure');
        },
        0,
    );

    assert.equal(enabled, false);
    assert.equal(attempts, 3);
});
