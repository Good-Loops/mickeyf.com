import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';
import notice from '../../../shared/privacyNotice.json' with { type: 'json' };

const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createViteTestServer({ root, configFile: false, esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@': `${root}/ts` } },
    appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
after(() => server.close());
const { default: Component } = await server.ssrLoadModule('/ts/components/SignedParentForm.tsx');
const policy = { enabled: true, privacyNoticeUrl: notice.noticeUrl, consentText: notice.consent.parent.text };
const request = { reference: '00000000-0000-4000-8000-000000000001', parentAccountId: '00000000-0000-4000-8000-000000000002',
    country: 'US', userName: 'Synthetic child (preview only)', verifiedContact: 'synthetic-parent@example.test',
    policyVersion: 'preview-only', consentVersion: notice.consent.parent.version, status: 'pending',
    expiresAt: '2026-10-20T00:00:00.000Z', publicPolicyDigest: 'c'.repeat(64),
    publicConsentText: notice.consent.publicScores.text, publicConsentVersion: notice.consent.publicScores.version };
const render = value => renderToStaticMarkup(React.createElement(Component, { request: value, policy }));
const markup = render(request);
test('printable form contains exact parent/request references, notice versions, contacts and separate unselected choices', () => {
    for (const text of [request.reference, request.parentAccountId, request.verifiedContact, request.userName,
        request.consentVersion, request.publicConsentVersion, request.publicPolicyDigest, notice.operatorAddress,
        notice.operatorTelephone, notice.signedParentForm.version, notice.version]) assert.ok(markup.includes(text));
    assert.match(markup, /Handwritten signature/u);
    assert.match(markup, /□ I authorize the private child account/u);
    assert.match(markup, /□ I separately authorize public leaderboard disclosure/u);
    assert.doesNotMatch(markup, /<input|<form|childPassword|idToken|grant=/u);
});
test('no public choice is offered without a separately bound disclosure policy; nickname HTML is escaped', () => {
    const value = render({ ...request, userName: '<script>synthetic</script>', publicConsentText: null, publicConsentVersion: null, publicPolicyDigest: null });
    assert.doesNotMatch(value, /<script>|Separate optional public disclosure|I separately authorize/u);
    assert.match(value, /&lt;script&gt;synthetic&lt;\/script&gt;/u);
});
if (process.env.SIGNED_FORM_PREVIEW_PATH) {
    const css = await readFile(new URL('./SignedParentForm.css', import.meta.url), 'utf8');
    await writeFile(process.env.SIGNED_FORM_PREVIEW_PATH, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Ludolume signed form — synthetic preview</title><style>body{font:16px/1.5 sans-serif;max-width:900px;margin:20px auto;padding:0 20px}${css}</style><body><p>Preview with synthetic request details. No account or consent exists.</p>${markup}</body></html>`, 'utf8');
}
