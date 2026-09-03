import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
    ThreeBossesControlsGuide,
    ThreeBossesDesktopOnly,
    ThreeBossesLoadingStatus,
} = await viteServer.ssrLoadModule(
    '/ts/pages/games/ThreeBosses.tsx',
);
const { default: ScoreSubmissionNotice } = await viteServer.ssrLoadModule(
    '/ts/components/ScoreSubmissionNotice.tsx',
);
const { isThreeBossesMobilePreviewRequested } = await viteServer.ssrLoadModule(
    '/ts/config/featureFlags.ts',
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
    assert.doesNotMatch(html, /Keyboard controls/);
});

test('the mobile preview query is exact and remains behind the local feature gate', () => {
    assert.equal(
        isThreeBossesMobilePreviewRequested('?three-bosses-mobile-preview=1', true),
        true,
    );
    assert.equal(
        isThreeBossesMobilePreviewRequested('?three-bosses-mobile-preview=true', true),
        false,
    );
    assert.equal(
        isThreeBossesMobilePreviewRequested('?three-bosses-mobile-preview=1', false),
        false,
    );
});

test('the branded loading surface exposes real, normalized progress without a heavy image', () => {
    const html = renderToStaticMarkup(
        React.createElement(ThreeBossesLoadingStatus, { progressPercent: 41.6 }),
    );

    assert.match(html, /Preparing arena/);
    assert.match(html, /Three Bosses/);
    assert.match(html, /aria-label="Loading Three Bosses"/);
    assert.match(html, /aria-valuemin="0"/);
    assert.match(html, /aria-valuemax="100"/);
    assert.match(html, /aria-valuenow="42"/);
    assert.match(html, /width:42%/);
    assert.match(html, />42%<\/span>/);
    assert.doesNotMatch(html, /<img/);
});

test('the desktop keyboard guide stays aligned with the live Unity bindings', async () => {
    const html = renderToStaticMarkup(
        React.createElement(ThreeBossesControlsGuide),
    );
    const inputActions = JSON.parse(await readFile(
        fileURLToPath(new URL(
            '../../../../unity/three-bosses/Assets/PlayerInputActions.inputactions',
            import.meta.url,
        )),
        'utf8',
    ));
    const pauseController = await readFile(
        fileURLToPath(new URL(
            '../../../../unity/three-bosses/Assets/Scripts/UI/GameplayPauseController.cs',
            import.meta.url,
        )),
        'utf8',
    );
    const gameplayBindings = inputActions.maps
        .find(({ name }) => name === 'Gameplay')
        ?.bindings ?? [];
    const hasBinding = (action, path) => gameplayBindings.some((binding) => (
        binding.action === action && binding.path === path
    ));

    assert.match(html, /^<section[^>]*class="three-bosses__controls"/);
    assert.match(html, /<h2[^>]*>Keyboard controls<\/h2>/);
    assert.match(html, /Move left \/ right/);
    assert.match(html, /Aim up \/ left \/ right/);
    assert.match(html, /Jump \/ double jump/);
    assert.match(html, /Dash/);
    assert.match(html, /Fire/);
    assert.match(html, /Pause \/ resume/);
    assert.doesNotMatch(html, /<(?:details|summary)|role="(?:dialog|menu)"/);

    assert.equal(hasBinding('Move', '<Keyboard>/a'), true);
    assert.equal(hasBinding('Move', '<Keyboard>/d'), true);
    assert.equal(hasBinding('Move', '<Keyboard>/leftArrow'), true);
    assert.equal(hasBinding('Move', '<Keyboard>/rightArrow'), true);
    assert.equal(hasBinding('AimUp', '<Keyboard>/w'), true);
    assert.equal(hasBinding('AimBack', '<Keyboard>/a'), true);
    assert.equal(hasBinding('AimFront', '<Keyboard>/d'), true);
    assert.equal(hasBinding('Jump', '<Keyboard>/space'), true);
    assert.equal(hasBinding('Dash', '<Keyboard>/leftShift'), true);
    assert.equal(hasBinding('Fire', '<Keyboard>/enter'), true);
    assert.match(pauseController, /Keyboard\.current\?\.escapeKey\.wasPressedThisFrame/);
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
