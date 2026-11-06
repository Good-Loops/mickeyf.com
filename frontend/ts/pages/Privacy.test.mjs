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

test('public contact contains the owner-approved operator details without local provenance fields', () => {
    assert.equal(notice.operatorName, 'Michel Silveira Dias Fingergut');
    assert.equal(notice.contactEmail, 'mickeyf.plays@gmail.com');
    assert.match(markup, /href="mailto:mickeyf\.plays@gmail\.com"/u);
    assert.deepEqual(Object.keys(notice).sort(), ['availabilityText', 'consent', 'contactEmail', 'noticeUrl', 'operatorAddress', 'operatorName', 'operatorTelephone', 'ptBR', 'sections', 'signedParentForm', 'version']);
    assert.equal(notice.operatorTelephone, '+55 71 99910 2221');
    assert.ok(markup.includes(notice.operatorTelephone));
    assert.ok(markup.includes(notice.operatorAddress));
    assert.doesNotMatch(markup, /tel:|C:\\Users\\|privateDraft|postalAddress|phoneNumber/u);
});

test('Portuguese notice includes every English section and both separate permissions', () => {
    assert.deepEqual(notice.ptBR.sections.map(section => section.id), notice.sections.map(section => section.id));
    assert.match(markup, /href="#portugues" lang="pt-BR"/u);
    assert.match(markup, /<section lang="pt-BR" aria-labelledby="portugues">/u);
    const translated = markup.slice(markup.indexOf('<section lang="pt-BR"'));
    for (const { id, title, text } of notice.ptBR.sections) {
        assert.ok(translated.includes(`id="privacidade-${id}"`));
        assert.ok(translated.includes(title));
        assert.ok(translated.includes(escaped(text)));
    }
    assert.ok(translated.includes(escaped(notice.signedParentForm.ptBR.parentConsent)));
    assert.ok(translated.includes(escaped(notice.signedParentForm.ptBR.publicConsent)));
    assert.match(translated, /Ler este aviso não concede nenhuma delas/u);
    assert.match(translated, /Não envie senhas ou códigos de acesso/u);
});

test('optional child usage and its separate permission are described in both languages', () => {
    const en = notice.sections.find(section => section.id === 'child-daily-usage')?.text ?? '';
    const pt = notice.ptBR.sections.find(section => section.id === 'child-daily-usage')?.text ?? '';
    assert.match(en, /Before enabling it.*ask for permission/u);
    assert.match(en, /guest or offline use or other apps/u);
    assert.match(en, /active database.*recovery copies/u);
    assert.match(pt, /Antes de ativá-lo.*solicitamos sua autorização/u);
    assert.match(pt, /visitante, offline ou em outros aplicativos/u);
    assert.match(pt, /banco de dados ativo.*cópias de recuperação/u);
});

test('both notices describe entered age, server screening and older iOS fallback', () => {
    const section = (sections, id) => sections.find(item => item.id === id)?.text ?? '';
    const englishAge = section(notice.sections, 'children');
    const portugueseAge = section(notice.ptBR.sections, 'children');
    const englishScreen = section(notice.sections, 'age-assurance');
    const portugueseScreen = section(notice.ptBR.sections, 'age-assurance');
    assert.match(englishAge, /age in years.*broad category.*country to our server/u);
    assert.match(portugueseAge, /idade em anos.*categoria ampla.*país ao nosso servidor/u);
    assert.match(englishScreen, /iOS versions before the native age-range API.*age entered/u);
    assert.match(portugueseScreen, /versões do iOS anteriores.*idade informada/u);
    assert.match(englishScreen, /pseudonymous server records.*up to 24 hours.*removed during maintenance/u);
    assert.match(portugueseScreen, /registros pseudonimizados.*até 24 horas.*removidos durante a manutenção/u);
    assert.match(englishScreen, /country and broad age category/u);
    assert.match(portugueseScreen, /país e uma categoria etária ampla/u);
});

test('public deletion section offers browser controls and a scoped email request without an authenticated session', () => {
    const deletion = markup.match(/<section aria-labelledby="privacy-deletion">([\s\S]*?)<\/section>/u)?.[1];
    assert.ok(deletion, 'the public notice must include a directly linkable deletion section');
    assert.match(deletion, /id="privacy-deletion"/u);
    assert.match(deletion, /href="\/account"/u);
    assert.match(deletion, /href="\/parent-accounts"/u);
    assert.ok(deletion.includes(`href="mailto:${notice.contactEmail}?subject=${encodeURIComponent('Ludolume account deletion request')}"`));
    assert.match(deletion, /Ludolume account and associated data/u);
    assert.match(deletion, /without reinstalling the app/u);
    assert.match(deletion, /Account ownership must be verified/u);
    assert.match(deletion, /Do not send passwords or sign-in codes/u);
    assert.doesNotMatch(deletion, /<(?:form|input|button)\b/u);
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
