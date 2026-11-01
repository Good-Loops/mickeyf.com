import assert from 'node:assert/strict';
import test, { after } from 'node:test';
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
const { default: Component, formTextForCopy } = await server.ssrLoadModule('/ts/components/SignedParentForm.tsx');
const policy = { enabled: true, privacyNoticeUrl: notice.noticeUrl, policyVersion: 'preview-only', consentText: notice.consent.parent.text, consentVersion: notice.consent.parent.version, signedFormVersion: notice.signedParentForm.version };
const request = { reference: '00000000-0000-4000-8000-000000000001', parentAccountId: '00000000-0000-4000-8000-000000000002',
    country: 'US', userName: 'Synthetic child (preview only)', verifiedContact: 'synthetic-parent@example.test',
    policyVersion: 'preview-only', consentVersion: notice.consent.parent.version, status: 'pending',
    expiresAt: '2026-10-20T00:00:00.000Z', publicPolicyDigest: 'c'.repeat(64),
    publicConsentText: notice.consent.publicScores.text, publicConsentVersion: notice.consent.publicScores.version };
const render = value => renderToStaticMarkup(React.createElement(Component, { request: value, policy }));
const escapeHtml = text => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&#x27;');
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
    for (const userName of ['<script>synthetic</script>', '<SCRIPT>synthetic</SCRIPT>']) {
        const value = render({ ...request, userName, publicConsentText: null, publicConsentVersion: null, publicPolicyDigest: null });
        assert.doesNotMatch(value, /<script>|Separate optional public disclosure|I separately authorize/iu);
        assert.match(value, /&lt;script&gt;synthetic&lt;\/script&gt;/iu);
    }
});
test('Brazil form shows the bound Portuguese notice, choices, references and no child credentials', () => {
    const value = render({ ...request, country: 'BR', userName: null });
    for (const text of [notice.signedParentForm.ptBR.notice, notice.signedParentForm.ptBR.parentConsent,
        notice.signedParentForm.ptBR.publicConsent, notice.signedParentForm.ptBR.labels.signature,
        request.reference, request.parentAccountId, request.verifiedContact, notice.signedParentForm.version]) assert.ok(value.includes(text));
    assert.match(value, /lang="pt-BR"/u);
    assert.match(value, /href="https:\/\/mickeyf\.com\/privacy#portugues"/u);
    assert.doesNotMatch(value, /<input|childPassword|idToken|grant=/u);
});
test('Brazil form refuses unknown parent or public consent wording rather than translating a different policy', () => {
    const br = { ...request, country: 'BR', userName: null };
    for (const [candidate, configured] of [
        [br, { ...policy, consentText: 'Changed policy' }],
        [br, { ...policy, consentVersion: 'changed-version' }],
        [br, { ...policy, policyVersion: 'changed-version' }],
        [br, { ...policy, signedFormVersion: 'different-form-version' }],
        [br, { ...policy, signedFormVersion: undefined }],
        [br, { ...policy, privacyNoticeUrl: 'javascript:alert(1)' }],
        [{ ...br, consentVersion: 'changed-version' }, policy],
        [{ ...br, publicConsentText: 'Changed public terms' }, policy],
        [{ ...br, publicConsentVersion: 'changed-version' }, policy],
    ]) {
        const value = renderToStaticMarkup(React.createElement(Component, { request: candidate, policy: configured }));
        assert.ok(value.includes(notice.signedParentForm.ptBR.labels.unavailable));
        assert.doesNotMatch(value, /<button|Assinatura à mão/u);
    }
});

test('the copyable form is offered only for the flow that collects credentials after approval', () => {
    for (const country of ['US', 'BR']) {
        const value = renderToStaticMarkup(React.createElement(Component, {
            request: { ...request, country, userName: null }, policy: { ...policy, credentialsAfterApproval: true },
        }));
        assert.match(value, country === 'BR' ? /Preparar texto do formulário/u : /Prepare form text/u);
        assert.ok(value.includes(request.reference));
        assert.ok(value.includes(request.verifiedContact));
        for (const text of [request.parentAccountId, request.expiresAt, request.policyVersion, request.consentVersion,
            request.publicConsentVersion, request.publicPolicyDigest, notice.signedParentForm.version, notice.version,
            country === 'BR' ? notice.signedParentForm.ptBR.notice : notice.signedParentForm.notice,
            country === 'BR' ? notice.signedParentForm.ptBR.parentConsent : policy.consentText,
            country === 'BR' ? notice.signedParentForm.ptBR.publicConsent : request.publicConsentText]) {
            assert.ok(value.includes(escapeHtml(text)), `${country} form is missing ${text}`);
        }
        assert.doesNotMatch(value, /Synthetic child|childPassword/u);
    }
    assert.doesNotMatch(markup, /Prepare form text/u);
});

test('copy text uses the displayed form verbatim and includes the privacy notice destination', () => {
    const displayed = `Form title\n${request.reference}\n${request.verifiedContact}\n${notice.consent.parent.text}\n□ Parent signature`;
    const text = formTextForCopy({ innerText: displayed, querySelector: () => ({ href: notice.noticeUrl }) });
    assert.ok(text.startsWith(displayed));
    assert.ok(text.includes(notice.noticeUrl));
    assert.doesNotMatch(text, /Synthetic child|childPassword/u);
    assert.equal(formTextForCopy({ innerText: ' Example ', querySelector: () => null }), 'Example');
});
