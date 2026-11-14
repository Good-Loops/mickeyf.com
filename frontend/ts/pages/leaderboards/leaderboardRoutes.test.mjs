import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
    MemoryRouter,
    Route,
    Routes,
    useParams,
} from 'react-router-dom';
import { createViteTestServer } from '../../testSupport/createViteTestServer.mjs';
import { focusRouteHeading } from '../../components/routeHeadingFocus.ts';

const frontendRoot = fileURLToPath(new URL('../../../', import.meta.url));
const viteServer = await createViteTestServer({
    root: frontendRoot,
    configFile: `${frontendRoot}/vite.config.ts`,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
});

after(async () => {
    await viteServer.close();
});

const {
    LeaderboardView,
    loadLeaderboardCatalogGames,
} = await viteServer.ssrLoadModule('/ts/pages/Leaderboard.tsx');
const {
    GameLeaderboardView,
} = await viteServer.ssrLoadModule('/ts/pages/leaderboards/GameLeaderboard.tsx');

const p4VegaGame = {
    gameId: 'p4-vega',
    displayName: 'p4-Vega',
    rulesVersion: 1,
    primaryMetric: 'score',
    sortDirection: 'descending',
    labels: { score: 'Score', completionTime: null, rank: null },
    rankState: 'not-applicable',
    submissionState: 'legacy-only',
};

const threeBossesGame = {
    gameId: 'three-bosses',
    displayName: 'Three Bosses',
    rulesVersion: 1,
    primaryMetric: 'completionTimeMs',
    sortDirection: 'ascending',
    labels: { score: 'Score', completionTime: 'Time', rank: 'Rank' },
    rankState: 'ranked',
    submissionState: 'disabled',
};

const catalog = {
    success: true,
    contractVersion: 1,
    games: [p4VegaGame, threeBossesGame],
};

const p4VegaLeaderboard = {
    success: true,
    contractVersion: 1,
    gameId: 'p4-vega',
    rulesVersion: 1,
    entries: [
        { position: 1, userName: 'Vega Pilot', score: 12_345 },
    ],
};

const threeBossesLeaderboard = {
    success: true,
    contractVersion: 1,
    gameId: 'three-bosses',
    rulesVersion: 1,
    entries: [
        {
            position: 1,
            userName: 'Boss Hunter',
            score: 163_308,
            completionTimeMs: 61_234,
            rank: 'A',
        },
    ],
};

function renderHub(props) {
    return renderToStaticMarkup(
        React.createElement(
            MemoryRouter,
            { initialEntries: ['/leaderboards'] },
            React.createElement(
                Routes,
                null,
                React.createElement(Route, {
                    path: '/leaderboards',
                    element: React.createElement(LeaderboardView, props),
                })
            )
        )
    );
}

function renderDetail(path, state) {
    function DetailRoute() {
        const { gameId } = useParams();
        return React.createElement(GameLeaderboardView, {
            gameId,
            state,
            onRetry() {},
        });
    }

    return renderToStaticMarkup(
        React.createElement(
            MemoryRouter,
            { initialEntries: [path] },
            React.createElement(
                Routes,
                null,
                React.createElement(Route, {
                    path: '/leaderboards/:gameId',
                    element: React.createElement(DetailRoute),
                })
            )
        )
    );
}

function assertDetailSurface(html) {
    assert.match(html, /class="leaderboard leaderboard--detail"/);
}

function findElement(node, predicate) {
    if (!React.isValidElement(node)) {
        return null;
    }
    if (predicate(node)) {
        return node;
    }

    for (const child of React.Children.toArray(node.props.children)) {
        const match = findElement(child, predicate);
        if (match) {
            return match;
        }
    }
    return null;
}

test('hub renders loading, success, empty, and error states with a retry action', () => {
    const loadingHtml = renderHub({
        games: [],
        isLoading: true,
        errorMessage: null,
        onRetry() {},
    });
    assert.match(loadingHtml, /Loading leaderboards…/);
    assert.match(loadingHtml, /id="leaderboards-title"/);
    assert.match(loadingHtml, /tabindex="-1"/);

    const successHtml = renderHub({
        games: catalog.games,
        isLoading: false,
        errorMessage: null,
        onRetry() {},
    });
    assert.match(successHtml, /href="\/leaderboards\/p4-vega"/);
    assert.match(successHtml, /href="\/leaderboards\/three-bosses"/);
    assert.match(successHtml, />Metric</);
    assert.match(successHtml, />Time</);

    const emptyHtml = renderHub({
        games: [],
        isLoading: false,
        errorMessage: null,
        onRetry() {},
    });
    assert.match(emptyHtml, /No leaderboards yet/);
    assert.match(emptyHtml, /Game leaderboards will appear here/);

    let retryCount = 0;
    const errorProps = {
        games: [],
        isLoading: false,
        errorMessage: 'Catalog temporarily unavailable.',
        onRetry() {
            retryCount += 1;
        },
    };
    const errorHtml = renderHub(errorProps);
    assert.match(errorHtml, /Leaderboards unavailable/);
    assert.match(errorHtml, /Catalog temporarily unavailable\./);
    assert.match(errorHtml, /<button[^>]*>Try again<\/button>/);

    const retryButton = findElement(
        LeaderboardView(errorProps),
        (element) => element.type === 'button'
    );
    assert.ok(retryButton);
    retryButton.props.onClick();
    assert.equal(retryCount, 1);
});

test('hub catalog request can retry the same loader after a transient error', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const readCatalog = async (signal) => {
        assert.equal(signal, controller.signal);
        attempts += 1;
        if (attempts === 1) {
            throw new Error('temporary outage');
        }
        return catalog;
    };

    await assert.rejects(
        loadLeaderboardCatalogGames(controller.signal, readCatalog),
        /temporary outage/
    );
    assert.deepEqual(
        await loadLeaderboardCatalogGames(controller.signal, readCatalog),
        catalog.games
    );
    assert.equal(attempts, 2);
});

test('direct p4-Vega route renders success, empty, and error states', () => {
    const loadingHtml = renderDetail('/leaderboards/p4-vega', {
        status: 'loading',
    });
    assertDetailSurface(loadingHtml);
    assert.match(loadingHtml, /Loading leaderboard…/);

    const successHtml = renderDetail('/leaderboards/p4-vega', {
        status: 'success',
        game: p4VegaGame,
        leaderboard: p4VegaLeaderboard,
    });
    assertDetailSurface(successHtml);
    assert.match(successHtml, /id="game-leaderboard-title"/);
    assert.match(successHtml, />p4-Vega<\/h1>/);
    assert.match(successHtml, /Vega Pilot/);
    assert.match(successHtml, /12,345/);
    assert.doesNotMatch(successHtml, /Game leaderboard|Leaderboard status/);

    const emptyHtml = renderDetail('/leaderboards/p4-vega', {
        status: 'success',
        game: p4VegaGame,
        leaderboard: { ...p4VegaLeaderboard, entries: [] },
    });
    assertDetailSurface(emptyHtml);
    assert.match(emptyHtml, /No results yet/);
    assert.match(emptyHtml, /No results have been recorded/);

    const errorHtml = renderDetail('/leaderboards/p4-vega', {
        status: 'error',
        game: p4VegaGame,
        message: 'Scores are taking a tea break.',
    });
    assertDetailSurface(errorHtml);
    assert.match(errorHtml, /p4-Vega leaderboard unavailable/);
    assert.match(errorHtml, /Scores are taking a tea break\./);
    assert.match(errorHtml, />Try again<\/button>/);
});

test('direct Three Bosses route renders success, empty, and error states', () => {
    const successHtml = renderDetail('/leaderboards/three-bosses', {
        status: 'success',
        game: threeBossesGame,
        leaderboard: threeBossesLeaderboard,
    });
    assertDetailSurface(successHtml);
    assert.match(successHtml, />Three Bosses<\/h1>/);
    assert.match(successHtml, /Boss Hunter/);
    assert.match(successHtml, /1:01\.234/);
    assert.match(successHtml, />A</);

    const emptyHtml = renderDetail('/leaderboards/three-bosses', {
        status: 'success',
        game: threeBossesGame,
        leaderboard: { ...threeBossesLeaderboard, entries: [] },
    });
    assertDetailSurface(emptyHtml);
    assert.match(emptyHtml, /No results yet/);
    assert.match(emptyHtml, /Three Bosses score submission is not open yet/);

    const errorHtml = renderDetail('/leaderboards/three-bosses', {
        status: 'error',
        game: threeBossesGame,
        message: 'Runs could not be loaded.',
    });
    assertDetailSurface(errorHtml);
    assert.match(errorHtml, /Three Bosses leaderboard unavailable/);
    assert.match(errorHtml, /Runs could not be loaded\./);
    assert.match(errorHtml, />Try again<\/button>/);
});

test('game results preserve table semantics, entry order and every supporting metric in compact rows', () => {
    for (const [game, leaderboard] of [[p4VegaGame, p4VegaLeaderboard], [threeBossesGame, threeBossesLeaderboard]]) {
        const entries = [...leaderboard.entries, { ...leaderboard.entries[0], position: 2, userName: 'Second <pilot>' }];
        const html = renderDetail(`/leaderboards/${game.gameId}`, { status: 'success', game, leaderboard: { ...leaderboard, entries } });
        assert.equal((html.match(/<th scope="col"/g) ?? []).length, 3);
        assert.equal((html.match(/class="leaderboard__position-badge"/g) ?? []).length, 2);
        assert.ok(html.indexOf(leaderboard.entries[0].userName) < html.indexOf('Second &lt;pilot&gt;'));
        assert.doesNotMatch(html, /data-label=/);
        assert.match(html, /<caption>/);
        assert.match(html, /<thead>/);
        assert.match(html, /<tbody>/);
        if (game.gameId === 'three-bosses') {
            assert.match(html, /<dt>Score<\/dt><dd>163,308<\/dd>/);
            assert.match(html, /<dt>Rank<\/dt><dd>A<\/dd>/);
            assert.match(html, /<strong class="leaderboard__result-value">1:01\.234<\/strong>/);
        } else {
            assert.doesNotMatch(html, /leaderboard__secondary/);
            assert.match(html, /<strong class="leaderboard__result-value">12,345<\/strong>/);
        }
    }
});

test('unknown direct route renders not-found recovery links', () => {
    const html = renderDetail('/leaderboards/not-a-game', {
        status: 'not-found',
        games: catalog.games,
    });

    assertDetailSurface(html);
    assert.match(html, /Leaderboard not found/);
    assert.match(html, /No leaderboard matches “not-a-game”/);
    assert.match(html, /href="\/leaderboards"/);
    assert.match(html, /href="\/leaderboards\/p4-vega"/);
    assert.match(html, /href="\/leaderboards\/three-bosses"/);
});

test('route heading focus preserves scroll position for keyboard navigation', () => {
    let observedOptions;
    focusRouteHeading({
        focus(options) {
            observedOptions = options;
        },
    });

    assert.deepEqual(observedOptions, { preventScroll: true });
    assert.doesNotThrow(() => focusRouteHeading(null));
});
