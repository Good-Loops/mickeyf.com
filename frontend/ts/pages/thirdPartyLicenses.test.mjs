import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { renderFrontendThirdPartyNotices } from '../../../scripts/generate-frontend-third-party-notices.mjs';

test('bundled notice preserves complete installed dependency and font licenses', () => {
    const bundled = readFileSync(new URL('../../public/third-party-notices.txt', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(bundled, renderFrontendThirdPartyNotices(), 'regenerate notices after production dependency changes');
    assert.match(bundled, /@pixi\/colord 2\.9\.6 \(MIT\)[\s\S]*Copyright \(c\) 2020 Vlad Shilov/u);
    assert.match(bundled, /fft\.js 4\.0\.4 \(MIT\)[\s\S]*Copyright Fedor Indutny, 2017/u);
    assert.match(bundled, /Three Bosses project third-party notice/u);
    assert.match(bundled, /Three Bosses Liberation Sans font license/u);
});

test('license route renders the bundled text and the app links to it', async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    try {
        const { default: Licenses } = await server.ssrLoadModule('/ts/pages/ThirdPartyLicenses.tsx');
        const html = renderToStaticMarkup(React.createElement(Licenses));
        assert.match(html, /Third-party licenses/u);
        assert.match(html, /@pixi\/colord 2\.9\.6/u);
        const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
        assert.match(app, /path="\/licenses"/u);
        assert.match(app, /<Link to="\/licenses">Third-party licenses<\/Link>/u);
    } finally { await server.close(); }
});
