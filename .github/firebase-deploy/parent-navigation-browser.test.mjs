import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../frontend/ts/testSupport/createViteTestServer.mjs';

const { chromium } = createRequire(import.meta.url)('playwright-core');
const root = fileURLToPath(new URL('../../frontend/', import.meta.url));
const state = Buffer.alloc(32, 1).toString('base64url');
const nonce = Buffer.alloc(32, 2).toString('base64url');
const grant = Buffer.alloc(32, 3).toString('base64url');
const children = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const sdkUrl = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
let browser, server, origin;

before(async () => {
    server = await createViteTestServer({ root, configFile:false, resolve:{alias:{'@':`${root}/ts`}},
        esbuild:{jsx:'automatic'}, define:{'import.meta.env.VITE_USE_PUBLIC_API':'"0"', 'import.meta.env.VITE_DEV_API_URL':'""'},
        logLevel:'error', server:{host:'127.0.0.1',port:0} }, { browser:true });
    await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel:'chrome', headless:true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t) {
    const context = await browser.newContext(); t.after(() => context.close());
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    const calls = [], external = [];
    let purpose, cancelResolve;
    const cancelled = new Promise(resolve => { cancelResolve = resolve; });
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.href === sdkUrl) return route.fulfill({ contentType:'application/javascript', body:`
            window.AppleID={auth:{init(input){window.__appleInit=input},signIn(){
                window.__appleCalls=(window.__appleCalls??0)+1;
                return new Promise(resolve=>{window.__finishApple=()=>resolve({authorization:{
                    state:window.__appleInit.state,id_token:'synthetic.identity.signature',code:'synthetic-code'}})});
            }}};` });
        if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
        if (!url.pathname.startsWith('/auth/') && !url.pathname.startsWith('/api/')) return route.continue();
        const body = request.postDataJSON(); calls.push({path:url.pathname,body});
        let value = {};
        if (url.pathname === '/auth/verify-token' || url.pathname === '/auth/renew') value = {loggedIn:true,user_name:'Synthetic'};
        else if (url.pathname === '/auth/providers/account') value = {hasPassword:false,googleLinked:false,googleDeletionEnabled:false,
            appleLinked:true,appleDeletionEnabled:true,providerCollectionAllowed:true};
        else if (url.pathname === '/auth/providers/config') value = {clients:[{clientKey:'apple-web',provider:'apple',platform:'web',
            clientId:'com.example.web',redirectUri:'https://example.test/login'}]};
        else if (url.pathname === '/auth/parent-registration/config') value = {enabled:true,creationEnabled:false,policyVersion:'synthetic',
            consentVersion:'synthetic',consentText:'Synthetic',privacyNoticeUrl:'https://mickeyf.com/privacy',countries:['US']};
        else if (url.pathname === '/auth/parent-registration/children/list') value = {children:children.map((accountId, i) => ({accountId,userName:`Synthetic child ${i+1}`,scoreVisibility:'private'}))};
        else if (url.pathname === '/auth/parent-registration/begin') { purpose=body.purpose; value={state,nonce,expiresInSeconds:300}; }
        else if (url.pathname === '/auth/parent-registration/complete') value = {grant,purpose,expiresInSeconds:300};
        else if (url.pathname === '/auth/parent-registration/cancel') { value={cancelled:true}; cancelResolve(); }
        else if (url.pathname === '/auth/parent-registration/scores/config') value = {enabled:true,policyVersion:'synthetic',
            consentVersion:'synthetic',consentText:'Synthetic publication consent',privacyNoticeUrl:'https://mickeyf.com/privacy'};
        else if (url.pathname === '/auth/parent-registration/scores/status') value = {visibility:'private',canPublish:true};
        else if (url.pathname === '/auth/parent-registration/forms/list') value = {forms:[]};
        else if (url.pathname === '/auth/parent-registration/withdraw' || url.pathname === '/auth/parent-registration/family/delete') value = {deleted:true};
        else if (url.pathname === '/auth/parent-registration/scores/publish') value = {visibility:'public'};
        return route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
    });
    await page.goto(`${origin}/parent-accounts`, {waitUntil:'domcontentloaded',timeout:45_000});
    await page.getByRole('button',{name:'Refresh child accounts'}).waitFor();
    return {page,calls,external,cancelled};
}

async function waitForCancellation(cancelled) {
    let timeout;
    try { await Promise.race([cancelled, new Promise((_,reject) => {
        timeout = setTimeout(() => reject(new Error('challenge cancellation was not observed')), 10_000);
    })]); }
    finally { clearTimeout(timeout); }
}

for (const mode of ['withdraw-child','delete-family']) test(`navigation prevents ${mode} approval and destructive send`, async t => {
    const {page,calls,external,cancelled} = await fixture(t);
    if (mode === 'withdraw-child') {
        await page.locator('section[aria-label="Manage child accounts"] select').selectOption(children[0]);
        await page.getByLabel('Type WITHDRAW AND DELETE').fill('WITHDRAW AND DELETE');
        await page.getByRole('button',{name:'Confirm deletion with Apple'}).click();
    } else {
        await page.getByLabel('I have checked this list and want to delete all these accounts.').check();
        await page.getByLabel('Type DELETE MY FAMILY').fill('DELETE MY FAMILY');
        await page.getByRole('button',{name:'Delete family with Apple'}).click();
    }
    await page.waitForFunction(() => window.__appleCalls === 1);
    await page.evaluate(() => { const push=history.pushState; history.pushState=function(...args) {
        const value=push.apply(this,args); if(location.pathname==='/') queueMicrotask(() => { window.__finishApple(); window.__delivered=true; }); return value;
    }; });
    await page.getByRole('link',{name:'Home',exact:true}).click();
    await page.waitForFunction(() => window.__delivered === true);
    await waitForCancellation(cancelled);
    assert.equal(calls.filter(call => call.path === '/auth/parent-registration/complete').length,0);
    assert.equal(calls.filter(call => ['/auth/parent-registration/withdraw','/auth/parent-registration/family/delete'].includes(call.path)).length,0);
    assert.deepEqual(external,[]);
});

test('changing the selected child before React cleanup cancels pending leaderboard approval', async t => {
    const {page,calls,external,cancelled} = await fixture(t);
    const select = page.locator('section[aria-label="Manage child accounts"] select');
    await select.selectOption(children[0]);
    await page.getByText('Synthetic publication consent',{exact:false}).waitFor();
    await page.getByLabel('Synthetic publication consent').check();
    await page.getByRole('button',{name:'Join leaderboards with Apple'}).click();
    await page.waitForFunction(() => window.__appleCalls === 1);
    await select.evaluate((element, id) => {
        element.value=id; element.dispatchEvent(new Event('change',{bubbles:true}));
        queueMicrotask(() => { window.__finishApple(); window.__delivered=true; });
    }, children[1]);
    await page.waitForFunction(() => window.__delivered === true);
    await waitForCancellation(cancelled);
    assert.equal(calls.filter(call => call.path === '/auth/parent-registration/complete').length,0);
    assert.equal(calls.filter(call => call.path === '/auth/parent-registration/scores/publish').length,0);
    assert.deepEqual(external,[]);
});
