import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../frontend/ts/testSupport/createViteTestServer.mjs';

const { chromium } = createRequire(import.meta.url)('playwright-core');
const root = fileURLToPath(new URL('../../frontend/', import.meta.url));
const games = [
    { gameId: 'p4-vega', displayName: 'p4-Vega', rulesVersion: 1, primaryMetric: 'score', sortDirection: 'descending',
        labels: { score: 'Score', completionTime: null, rank: null }, rankState: 'not-applicable', submissionState: 'legacy-only' },
    { gameId: 'three-bosses', displayName: 'Three Bosses', rulesVersion: 1, primaryMetric: 'completionTimeMs', sortDirection: 'ascending',
        labels: { score: 'Score', completionTime: 'Time', rank: 'Rank' }, rankState: 'ranked', submissionState: 'disabled' },
];
const players = ['A_LongPlayerName_ThatWrapsWithoutHidingTheirResult', 'Luna', 'Another Pilot'];
const scores = [987654321, 123456, 12345];
const times = [59876, 61234, 86400000];
let server, browser, origin;

before(async () => {
    server = await createViteTestServer({ root, configFile: false, resolve: { alias: { '@': `${root}/ts` } },
        esbuild: { jsx: 'automatic' }, logLevel: 'error',
        define: { 'import.meta.env.VITE_USE_PUBLIC_API': '"0"', 'import.meta.env.VITE_DEV_API_URL': '""' },
        server: { host: '127.0.0.1', port: 0 } }, { browser: true });
    await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t, gameId, width, height, { empty = false, fail = false, pending = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    t.after(() => context.close());
    await context.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.nativeApp = 'ios'; }, { once: true });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(30_000);
    let releaseRequest;
    const held = new Promise(resolve => { releaseRequest = resolve; });
    t.after(releaseRequest);
    await context.route('**/*', async route => {
        const request = route.request(); const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname.endsWith('/api/leaderboards')) {
            assert.equal(request.method(), 'GET');
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, contractVersion: 1, games }) });
        }
        if (url.pathname.endsWith(`/api/leaderboards/${gameId}`)) {
            assert.equal(request.method(), 'GET');
            if (pending) await held;
            if (fail) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, contractVersion: 1, error: 'SERVER_ERROR' }) });
            const entries = empty ? [] : players.map((userName, index) => ({ position: index + 1, userName, score: scores[index],
                ...(gameId === 'three-bosses' ? { completionTimeMs: times[index], rank: ['S', 'A', 'B'][index] } : {}) }));
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, contractVersion: 1, gameId, rulesVersion: 1, entries }) });
        }
        if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) {
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ loggedIn: false, clients: [] }) });
        }
        return route.continue();
    });
    await page.goto(`${origin}/leaderboards/${gameId}`);
    assert.equal(await page.locator('html').getAttribute('data-native-app'), 'ios');
    return { page, releaseRequest };
}

async function noOverflow(page) {
    const geometry = await page.evaluate(() => Object.fromEntries(['html', '.main', '.leaderboard__table-wrapper'].map(selector => {
        const node = document.querySelector(selector);
        return [selector, node ? node.scrollWidth - node.clientWidth : 0];
    })));
    assert.ok(Object.values(geometry).every(value => value <= 1), JSON.stringify(geometry));
}

for (const game of games) {
    for (const [width, height] of [[393, 852], [852, 393], [1440, 900]]) {
        test(`${game.displayName} ${width}x${height} uses compact semantic rows with readable complete results`, async t => {
            const { page } = await fixture(t, game.gameId, width, height);
            await page.locator('tbody tr').last().waitFor();
            await page.evaluate(() => document.fonts.ready);
            assert.equal(await page.getByRole('table').count(), 1);
            assert.equal(await page.getByRole('columnheader').count(), 3);
            assert.equal(await page.getByRole('columnheader', { name: 'Position', exact: true }).count(), 1);
            assert.deepEqual(await page.locator('.leaderboard__player-name').allTextContents(), players);
            assert.deepEqual(await page.locator('.leaderboard__position-badge').allTextContents(), ['1', '2', '3']);
            assert.equal(await page.locator('tbody tr').first().getByRole('cell').count(), 3);
            assert.equal(await page.getByRole('table').evaluate(node => getComputedStyle(node).display), 'table');
            assert.ok(await page.locator('.leaderboard--detail').evaluate(node => Math.abs(node.getBoundingClientRect().top
                - node.parentElement.getBoundingClientRect().top - parseFloat(getComputedStyle(node.parentElement).paddingTop)) <= 1),
            'Result count does not leave an empty band above the ranking');
            const row = await page.locator('tbody tr').first().boundingBox();
            const player = await page.locator('.leaderboard__player-name').first().boundingBox();
            const primary = await page.locator('td.leaderboard__primary').first().boundingBox();
            assert.ok(row.height <= 120, `Long name remains in a compact row: ${row.height}`);
            assert.ok(player.x + player.width <= primary.x + 1, 'Name cannot overlap the primary metric');
            assert.equal(await page.locator('td.leaderboard__primary').first().evaluate(node => getComputedStyle(node).textAlign), 'right');
            if (game.gameId === 'three-bosses') {
                assert.deepEqual(await page.locator('.leaderboard__result-value').allTextContents(), ['59.876s', '1:01.234', '24:00:00.000']);
                assert.deepEqual(await page.locator('.leaderboard__secondary').first().locator('dt').allTextContents(), ['Score', 'Rank']);
                assert.deepEqual(await page.locator('.leaderboard__secondary').first().locator('dd').allTextContents(), ['987,654,321', 'S']);
            } else {
                assert.deepEqual(await page.locator('.leaderboard__result-value').allTextContents(), ['987,654,321', '123,456', '12,345']);
                assert.equal(await page.locator('.leaderboard__secondary').count(), 0);
            }
            await noOverflow(page);
        });
    }
    test(`${game.displayName} empty ranking retains its truthful status and recovery navigation`, async t => {
        const { page } = await fixture(t, game.gameId, 393, 852, { empty: true });
        await page.getByRole('heading', { name: 'No results yet' }).waitFor();
        assert.equal(await page.getByRole('table').count(), 0);
        assert.equal(await page.getByRole('status').count(), 1);
        assert.equal(await page.getByRole('link', { name: '← All leaderboards' }).getAttribute('href'), '/leaderboards');
        await noOverflow(page);
    });
}

test('leaderboard request keeps loading feedback until its existing error and retry state is available', async t => {
    const { page, releaseRequest } = await fixture(t, 'three-bosses', 393, 852, { pending: true, fail: true });
    await page.getByRole('heading', { name: 'Loading leaderboard…' }).waitFor();
    assert.equal(await page.getByRole('table').count(), 0);
    releaseRequest();
    await page.getByRole('heading', { name: 'Three Bosses leaderboard unavailable' }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Try again' }).count(), 1);
    await noOverflow(page);
});
