import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';
import { approvedPrivacyConsentEnvironment } from '../../../scripts/privacy-notice-consent.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const notice = JSON.parse(await readFile(new URL('../../../shared/privacyNotice.json', import.meta.url), 'utf8'));
const server = await createViteTestServer({ root, configFile: false, esbuild: { jsx: 'automatic' },
    appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
after(() => server.close());
const { default: Privacy } = await server.ssrLoadModule('/ts/pages/Privacy.tsx');
const markup = renderToStaticMarkup(React.createElement(Privacy));
const escaped = value => renderToStaticMarkup(React.createElement('p', null, value));

test('public notice renders every reviewed paragraph and separate permissions without collecting consent', () => {
    assert.match(markup, /<h1 id="privacy-title">Ludolume privacy notice<\/h1>/u);
    for (const { text } of notice.sections) assert.ok(markup.includes(escaped(text)));
    assert.ok(markup.includes(escaped(notice.consent.parent.text)));
    assert.ok(markup.includes(escaped(notice.consent.publicScores.text)));
    assert.match(markup, /Public leaderboard participation is optional and is authorized separately below\./u);
    assert.match(markup, /Reading this notice does not grant either permission\./u);
    assert.doesNotMatch(markup, /<(?:form|input|button)\b/u);
    assert.match(markup, /Feature availability can vary by platform and account/u);
});

test('public contact is the approved legal name and email, without private contact or provenance fields', () => {
    assert.equal(notice.operatorName, 'Michel Silveira Dias Fingergut');
    assert.equal(notice.contactEmail, 'mickeyf.plays@gmail.com');
    assert.match(markup, /href="mailto:mickeyf\.plays@gmail\.com"/u);
    assert.deepEqual(Object.keys(notice).sort(), ['availabilityText', 'consent', 'contactEmail', 'noticeUrl', 'operatorName', 'sections', 'version']);
    assert.doesNotMatch(markup, /tel:|C:\\Users\\|privateDraft|postalAddress|phoneNumber/u);
});

test('offline consent fragment matches the displayed text and adds no activation, country or assurance setting', async () => {
    const environment = await approvedPrivacyConsentEnvironment();
    assert.deepEqual(Object.keys(environment).sort(), ['PARENT_CONSENT_TEXT', 'PARENT_CONSENT_VERSION', 'PARENT_PRIVACY_NOTICE_URL',
        'PUBLIC_SCORE_CONSENT_TEXT', 'PUBLIC_SCORE_CONSENT_VERSION', 'PUBLIC_SCORE_PRIVACY_NOTICE_URL']);
    assert.equal(environment.PARENT_CONSENT_TEXT, notice.consent.parent.text);
    assert.equal(environment.PUBLIC_SCORE_CONSENT_TEXT, notice.consent.publicScores.text);
    assert.notEqual(environment.PARENT_CONSENT_VERSION, environment.PUBLIC_SCORE_CONSENT_VERSION);
    assert.equal(environment.PARENT_PRIVACY_NOTICE_URL, 'https://mickeyf.com/privacy');
    assert.equal(environment.PUBLIC_SCORE_PRIVACY_NOTICE_URL, environment.PARENT_PRIVACY_NOTICE_URL);
});
