import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../frontend/ts/testSupport/createViteTestServer.mjs';

const { chromium } = createRequire(import.meta.url)('playwright-core');
const root = fileURLToPath(new URL('../../frontend/', import.meta.url));
const notice = JSON.parse(readFileSync(new URL('../../shared/privacyNotice.json', import.meta.url), 'utf8'));
const state = Buffer.alloc(32, 1).toString('base64url');
const nonce = Buffer.alloc(32, 2).toString('base64url');
const reference = '11111111-1111-4111-8111-111111111111';
const parentId = '22222222-2222-4222-8222-222222222222';
const childId = '33333333-3333-4333-8333-333333333333';
const policy = { enabled: true, audience: 'children-included', credentialsAfterApproval: true,
    creationEnabled: true, policyVersion: 'synthetic-parent-reviewed', countries: ['BR', 'US'],
    signedFormCountries: ['BR', 'US'], signedFormVersion: notice.signedParentForm.version,
    consentVersion: notice.consent.parent.version, consentText: notice.consent.parent.text,
    privacyNoticeUrl: 'https://mickeyf.com/privacy' };
const component = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { BrowserRouter } from 'react-router-dom';
    import ParentRegistration from '/ts/components/ParentRegistration.tsx';
    import { createParentRegistrationApi } from '/ts/services/parentRegistrationApi.ts';
    import '/sass/style.scss';
    const api = createParentRegistrationApi('', fetch, {requireChildAudience:true});
    createRoot(document.getElementById('root')).render(React.createElement(BrowserRouter, null, React.createElement(ParentRegistration, {
        api, authenticated:true, accountKey:'Synthetic Parent', requireChildAudience:true,
        clients:[{clientKey:'google-web',provider:'google',platform:'web',clientId:'synthetic.apps.googleusercontent.com'}],
        acquire:async () => 'synthetic.identity.signature',
    })));
`;
let browser, server, origin;
before(async () => {
    server = await createViteTestServer({ root, configFile: false,
        resolve: { alias: { '@': `${root}/ts` } }, esbuild: { jsx: 'automatic' },
        plugins: [{ name:'synthetic-parent-consent-fixture',
            resolveId:id => id === '/__parent-consent.mjs' ? '\0parent-consent' : undefined,
            load:id => id === '\0parent-consent' ? component : undefined }],
        logLevel:'error', server:{host:'127.0.0.1',port:0} }, {browser:true});
    await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({channel:'chrome',headless:true});
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t, country) {
    const context = await browser.newContext(); t.after(() => context.close());
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    const calls = [], external = [];
    let form = null;
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
        if (url.pathname === '/__parent-consent') return route.fulfill({contentType:'text/html',body:
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/__parent-consent.mjs"></script></body></html>'});
        if (!url.pathname.startsWith('/auth/parent-registration')) return route.continue();
        const path = url.pathname.slice('/auth/parent-registration'.length);
        const body = request.postDataJSON(); calls.push({path,body});
        let result;
        if (path === '/config') result = policy;
        else if (path === '/forms/list') result = {forms:form ? [form] : []};
        else if (path === '/begin') {
            assert.equal(body.country,country); assert.equal(body.adultAttestation,true);
            assert.equal(body.guardianAttestation,true); assert.equal(body.consent,true);
            assert.equal('userName' in body,false); assert.equal('password' in body,false);
            if (form?.status === 'approved') assert.equal(body.formReference, reference);
            else assert.equal(Object.hasOwn(body, 'formReference'), false);
            result = {state,nonce,expiresInSeconds:300};
        } else if (path === '/forms/request') {
            assert.deepEqual(body,{state,idToken:'synthetic.identity.signature'});
            form = {reference,parentAccountId:parentId,country,userName:null,verifiedContact:'synthetic-parent@example.test',
                policyVersion:policy.policyVersion,consentVersion:policy.consentVersion,status:'pending',
                expiresAt:new Date(Date.now()+86_400_000).toISOString(),
                publicPolicyDigest:null,publicConsentText:null,publicConsentVersion:null};
            result = {form};
        } else if (path === '/complete') {
            assert.equal(form?.status,'approved'); result = {grant:nonce,purpose:'create-child',expiresInSeconds:300};
        } else if (path === '/children') {
            assert.equal(form?.status,'approved');
            assert.deepEqual(body,{grant:nonce,userName:'Synthetic Player',password:'Synthetic password 123!',formReference:reference});
            result = {created:true,child:{accountId:childId,userName:'Synthetic Player',scoreVisibility:'private'}};
        } else { return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'UNAVAILABLE'})}); }
        return route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
    });
    await page.goto(`${origin}/__parent-consent`,{timeout:30_000});
    await page.getByRole('combobox',{name:/Child's country/}).selectOption(country);
    return {page,calls,external,setStatus:status => { form = {...form,status}; }};
}
const labels = country => country === 'BR' ? {
    adult: notice.signedParentForm.ptBR.labels.adult, guardian: notice.signedParentForm.ptBR.labels.guardianCheck,
    consent: notice.signedParentForm.ptBR.labels.consentCheck, confirm: 'Confirmar com Google',
    form: notice.signedParentForm.ptBR.labels.formAria, refresh: 'Atualizar solicitações de formulário assinado',
    approved: 'Solicitação de conta infantil: aprovado', rejected: 'Solicitação de conta infantil: recusado',
    nickname: 'Apelido da criança', password: 'Senha da criança', create: 'Criar conta infantil privada',
    success: 'A conta Synthetic Player foi criada com resultados privados. Você continua conectado à conta de responsável.',
} : {
    adult: 'I am 18 or older.', guardian: "I am this child's parent or legal guardian and can give this consent.",
    consent: 'I agree to this child-account consent.', confirm: 'Confirm with Google',
    form: 'Signed parent consent form', refresh: 'Refresh signed form requests',
    approved: 'Child account request: approved', rejected: 'Child account request: rejected',
    nickname: "Child's nickname", password: "Child's password", create: 'Create private child account',
    success: 'Created Synthetic Player with private scores. You are still signed in to your parent account.',
};
async function confirmParent(page, country) {
    const text = labels(country);
    await page.getByLabel(text.adult,{exact:true}).check();
    await page.getByLabel(text.guardian,{exact:true}).check();
    await page.getByLabel(text.consent,{exact:true}).check();
    await page.getByRole('button',{name:text.confirm,exact:true}).click();
}
for (const country of ['BR','US']) test(`${country} signed parent flow collects child credentials only after approval`,async t => {
    const {page,calls,external,setStatus} = await fixture(t,country);
    const text = labels(country);
    assert.equal(await page.locator('input:not([type=checkbox])').count(),0);
    await confirmParent(page,country);
    await page.getByRole('article',{name:text.form}).waitFor();
    const formText = await page.getByRole('article',{name:text.form}).innerText();
    const pageText = await page.locator('body').innerText();
    if (country === 'BR') {
        assert.match(formText, /responda à mensagem.*digitalização ou fotografia/i);
        assert.match(pageText, /confira o Spam e responda/i);
    } else {
        assert.match(formText, /reply to that message with a scan or photograph/i);
        assert.match(pageText, /check Spam and reply/i);
    }
    assert.equal(await page.locator('input:not([type=checkbox])').count(),0);
    assert.equal(await page.getByRole('button',{name:text.confirm,exact:true}).isDisabled(),true);
    assert.equal(calls.filter(call => ['/complete','/children'].includes(call.path)).length,0);
    setStatus('approved');
    await page.getByRole('button',{name:text.refresh,exact:true}).click();
    await page.getByRole('button',{name:text.approved,exact:true}).waitFor();
    await page.getByRole('button',{name:text.confirm,exact:true}).click();
    await page.getByLabel(text.nickname,{exact:true}).fill('Synthetic Player');
    await page.getByLabel(text.password,{exact:true}).fill('Synthetic password 123!');
    await page.getByRole('button',{name:text.create,exact:true}).click();
    await page.getByText(text.success,{exact:true}).waitFor();
    const begins = calls.filter(call => call.path === '/begin');
    assert.equal(begins.length,2);
    assert.equal(Object.hasOwn(begins[0].body,'formReference'),false);
    assert.equal(begins[1].body.formReference,reference);
    assert.equal(calls.filter(call => call.path === '/children').length,1);
    assert.equal(await page.evaluate(() => localStorage.length+sessionStorage.length),0);
    assert.deepEqual(external,[]);
});

for (const country of ['BR','US']) test(`${country} rejected consent cannot be submitted again or create a child`,async t => {
    const {page,calls,setStatus} = await fixture(t,country);
    const text = labels(country);
    await confirmParent(page,country);
    await page.getByRole('article',{name:text.form}).waitFor();
    setStatus('rejected');
    await page.getByRole('button',{name:text.refresh,exact:true}).click();
    await page.getByRole('button',{name:text.rejected,exact:true}).waitFor();
    await page.getByRole('button',{name:text.rejected,exact:true}).click();
    await page.getByText(country === 'BR' ? /O formulário não foi aprovado/ : /The form was not approved/).waitFor();
    assert.equal(await page.getByRole('article',{name:text.form}).count(),0);
    assert.equal(await page.getByRole('button',{name:text.confirm,exact:true}).isDisabled(),true);
    assert.equal(await page.locator('input:not([type=checkbox])').count(),0);
    assert.equal(calls.filter(call => ['/complete','/children'].includes(call.path)).length,0);
});
