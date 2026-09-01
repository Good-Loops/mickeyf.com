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
import { createServer } from 'vite';
import { focusRouteHeading } from '../../components/routeHeadingFocus.ts';

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

const {
    LeaderboardView,
    loadLeaderboardCatalogGames,
} = await viteServer.ssrLoadModule('/ts/pages/Leaderboard.tsx');
const {
    GameLeaderboardView,
    loadGameLeaderboardState,
} = await viteServer.ssrLoadModule('/ts/pages/leaderboards/GameLeaderboard.tsx');
const { LeaderboardRequestError } = await viteServer.ssrLoadModule(
    '/ts/services/leaderboardApi.ts'
);

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

test('detail loader selects both known games and settles failures safely', async () => {
    const responses = new Map([
        ['p4-vega', p4VegaLeaderboard],
        ['three-bosses', threeBossesLeaderboard],
    ]);
    const readers = {
        readCatalog: async () => catalog,
        readGame: async (gameId) => responses.get(gameId),
    };

    assert.deepEqual(
        await loadGameLeaderboardState('p4-vega', undefined, readers),
        {
            status: 'success',
            game: p4VegaGame,
            leaderboard: p4VegaLeaderboard,
        }
    );
    assert.deepEqual(
        await loadGameLeaderboardState('three-bosses', undefined, readers),
        {
            status: 'success',
            game: threeBossesGame,
            leaderboard: threeBossesLeaderboard,
        }
    );

    let gameReadCount = 0;
    const notFound = await loadGameLeaderboardState('not-a-game', undefined, {
        readCatalog: async () => catalog,
        readGame: async () => {
            gameReadCount += 1;
            return p4VegaLeaderboard;
        },
    });
    assert.deepEqual(notFound, { status: 'not-found', games: catalog.games });
    assert.equal(gameReadCount, 0);

    const failed = await loadGameLeaderboardState('p4-vega', undefined, {
        readCatalog: async () => catalog,
        readGame: async () => {
            throw new Error('service unavailable');
        },
    });
    assert.deepEqual(failed, {
        status: 'error',
        game: p4VegaGame,
        message: 'service unavailable',
    });

    const mismatchedRules = await loadGameLeaderboardState('p4-vega', undefined, {
        readCatalog: async () => catalog,
        readGame: async () => ({
            ...p4VegaLeaderboard,
            rulesVersion: p4VegaGame.rulesVersion + 1,
        }),
    });
    assert.deepEqual(mismatchedRules, {
        status: 'error',
        game: p4VegaGame,
        message: 'The leaderboard service returned an unexpected response.',
    });

    for (const gameId of ['p4-vega', 'three-bosses']) {
        const apiNotFound = await loadGameLeaderboardState(gameId, undefined, {
            readCatalog: async () => catalog,
            readGame: async () => {
                throw new LeaderboardRequestError(
                    'That leaderboard does not exist.',
                    404,
                    'UNKNOWN_GAME'
                );
            },
        });
        assert.deepEqual(apiNotFound, {
            status: 'not-found',
            games: catalog.games,
        });
    }
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
