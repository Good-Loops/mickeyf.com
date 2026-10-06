import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createViteTestServer({ root, configFile: `${root}/vite.config.ts`, appType: 'custom', logLevel: 'silent',
    define: { 'import.meta.env.VITE_PRIVACY_NOTICE_URL': '""' }, server: { middlewareMode: true } });
after(() => server.close());
const { default: PrivacyNoticeLink } = await server.ssrLoadModule('/ts/components/PrivacyNoticeLink.tsx');
const render = url => renderToStaticMarkup(React.createElement(PrivacyNoticeLink, { url }));
test('notice is a native accessible link with an announced new tab, opener isolation and no referrer', () => {
    const html = render('https://notice.example.test/privacy#children');
    assert.match(html, /href="https:\/\/notice.example.test\/privacy#children"/u);
    assert.match(html, /target="_blank"/u); assert.match(html, /rel="noopener noreferrer"/u);
    assert.match(html, /referrerPolicy="no-referrer"/u);
    assert.match(html, /Privacy notice <span>\(opens in a new tab\)<\/span>/u);
});
test('an unset or invalid notice is omitted, never replaced by a guessed route or executable link', () => {
    for (const value of [undefined, '', 'javascript:alert(1)', '/privacy', 'https://u:p@notice.example.test']) assert.equal(render(value), '');
});
