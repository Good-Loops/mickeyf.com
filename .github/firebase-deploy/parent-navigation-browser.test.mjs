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

async function fixture(t, options = {}) {
    const context = await browser.newContext(); t.after(() => context.close());
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    const calls = [], external = [];
    let purpose, cancelResolve, releaseScores;
    let linked = !options.passwordAccount;
    const scoresReady = new Promise(resolve => { releaseScores = resolve; });
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
        else if (url.pathname === '/auth/providers/account') {
            if (options.holdMethods) await new Promise(resolve => setTimeout(resolve, 12_000));
            value = {hasPassword:!!options.passwordAccount,googleLinked:false,googleDeletionEnabled:false,
                appleLinked:linked,appleDeletionEnabled:linked,providerCollectionAllowed:true};
        }
        else if (url.pathname === '/auth/providers/config') value = {clients:[{clientKey:'apple-web',provider:'apple',platform:'web',
            clientId:'com.example.web',redirectUri:'https://example.test/login'}]};
        else if (url.pathname === '/auth/parent-registration/config') value = {enabled:true,creationEnabled:false,policyVersion:'synthetic',
            consentVersion:'synthetic',consentText:'Synthetic',privacyNoticeUrl:'https://mickeyf.com/privacy',countries:['US']};
        else if (url.pathname === '/auth/parent-registration/children/list') {
            assert.deepEqual(body, { identitiesOnly: true });
            value = {children:children.map((accountId, i) => ({accountId,userName:`Synthetic child ${i+1}`}))};
        }
        else if (url.pathname === '/auth/parent-registration/begin') { purpose=body.purpose; value={state,nonce,expiresInSeconds:300}; }
        else if (url.pathname === '/auth/parent-registration/complete') value = {grant,purpose,expiresInSeconds:300};
        else if (url.pathname === '/auth/parent-registration/cancel') { value={cancelled:true}; cancelResolve(); }
        else if (url.pathname === '/auth/parent-registration/scores/config') value = {enabled:true,policyVersion:'synthetic',
            consentVersion:'synthetic',consentText:'Synthetic publication consent',privacyNoticeUrl:'https://mickeyf.com/privacy'};
        else if (url.pathname === '/auth/parent-registration/scores/status') {
            if (options.holdScores) await scoresReady;
            if (options.failScores) return route.fulfill({status:500,contentType:'application/json',body:'{}'});
            value = {visibility:'private',canPublish:true};
        }
        else if (url.pathname === '/auth/providers/begin') value = {state,nonce,expiresInSeconds:300};
        else if (url.pathname === '/auth/providers/complete') { linked = true; value = {success:true,linked:true}; }
        else if (url.pathname === '/auth/parent-registration/forms/list') value = {forms:[]};
        else if (url.pathname === '/auth/parent-registration/withdraw' || url.pathname === '/auth/parent-registration/family/delete') value = {deleted:true};
        else if (url.pathname === '/auth/parent-registration/scores/publish') value = {visibility:'public'};
        return route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
    });
    await page.goto(`${origin}/parent-accounts`, {waitUntil:'domcontentloaded',timeout:45_000});
    await page.getByRole('button',{name:'Refresh child accounts'}).waitFor();
    return {page,calls,external,cancelled,releaseScores};
}

test('account waits for its controls and keeps the link confirmation after refreshing', async t => {
    const { page, releaseScores } = await fixture(t, { passwordAccount:true, holdScores:true });
    await page.goto(`${origin}/account`);
    await page.locator('.page-status--loading').waitFor();
    assert.equal(await page.locator('.manage-account').isVisible(), false);
    releaseScores();
    const link = page.getByRole('button', { name:'Continue with Apple' });
    await link.waitFor();
    assert.equal(await page.locator('.page-status--loading').count(), 0);
    await link.click();
    const password = page.locator('.swal2-popup input[type="password"]');
    assert.ok(parseFloat(await password.evaluate(input => getComputedStyle(input).fontSize)) >= 16,
        'the password input must be large enough to avoid iPhone focus zoom');
    await password.fill('synthetic-password');
    await page.getByRole('button', { name:'Continue', exact:true }).click();
    await page.waitForFunction(() => window.__appleCalls === 1);
    await page.evaluate(() => window.__finishApple());
    await page.getByText('Apple account linked successfully.', {exact:true}).waitFor();
    await page.getByText('Linked sign-in: Apple', {exact:true}).waitFor();
});

test('account opens with a retry message if leaderboard status fails', async t => {
    const { page } = await fixture(t, { failScores:true });
    await page.goto(`${origin}/account`);
    await page.getByText('Leaderboard choices could not be loaded. Please retry.', {exact:true}).waitFor();
    assert.equal(await page.locator('.manage-account').isVisible(), true);
    assert.equal(await page.locator('.page-status--loading').count(), 0);
});

test('account stops loading and offers retry when account methods time out', async t => {
    const { page } = await fixture(t, { holdMethods:true });
    await page.goto(`${origin}/account`);
    await page.getByRole('button', {name:'Try again', exact:true}).waitFor({timeout:14_000});
    assert.equal(await page.locator('.manage-account').isVisible(), true);
    assert.equal(await page.locator('.page-status--loading').count(), 0);
});

test('password dialog moves only when a simulated keyboard covers its input', async t => {
    const { page } = await fixture(t);
    const result = await page.evaluate(async () => {
        const { keepDialogInputVisible } = await import('/ts/components/dialogKeyboard.ts');
        const viewport = new EventTarget();
        Object.assign(viewport, { offsetTop:0, height:700 });
        Object.defineProperty(window, 'visualViewport', { configurable:true, value:viewport });
        const popup = document.createElement('div');
        popup.style.cssText = 'position:fixed;top:150px;left:20px;width:250px;height:240px';
        popup.innerHTML = '<input type="password" style="position:absolute;top:180px">';
        document.body.append(popup);
        const input = popup.querySelector('input');
        input.focus();
        const release = keepDialogInputVisible(popup, input);
        await new Promise(requestAnimationFrame);
        const before = popup.style.translate;
        viewport.height = 300;
        viewport.dispatchEvent(new Event('resize'));
        await new Promise(requestAnimationFrame);
        const after = popup.style.translate;
        const bottom = input.getBoundingClientRect().bottom;
        release();
        const restored = popup.style.translate;
        popup.remove();
        return {before, after, bottom, restored};
    });
    assert.equal(result.before, '');
    assert.notEqual(result.after, '');
    assert.ok(result.bottom <= 300, JSON.stringify(result));
    assert.equal(result.restored, '');
});

test('a direct privacy deletion link opens at the account deletion instructions', async t => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/privacy#privacy-deletion`);
    const heading = page.locator('#privacy-deletion');
    await heading.waitFor();
    await page.waitForFunction(() => {
        const rect = document.querySelector('#privacy-deletion')?.getBoundingClientRect();
        return rect && rect.top >= 0 && rect.top < 150;
    });
    assert.match(await heading.innerText(), /account and family deletion/i);
    assert.equal(await page.locator('a[href^="mailto:"]').filter({ hasText: 'email an account deletion request' }).count(), 1);
});

async function waitForCancellation(cancelled) {
    let timeout;
    try { await Promise.race([cancelled, new Promise((_,reject) => {
        timeout = setTimeout(() => reject(new Error('challenge cancellation was not observed')), 10_000);
    })]); }
    finally { clearTimeout(timeout); }
}

for (const width of [320, 390, 1024]) test(`account leaderboard choice stays usable at ${width}px`, async t => {
    const {page, calls} = await fixture(t);
    await page.setViewportSize({ width, height: 850 });
    await page.goto(`${origin}/account`);
    await page.getByText('Linked sign-in: Apple', { exact: true }).waitFor();
    const choice = page.getByLabel('Synthetic publication consent');
    await choice.waitFor();
    const join = page.getByRole('button', { name: 'Join leaderboards with Apple' });
    assert.equal(await join.isEnabled(), false);
    const geometry = await page.evaluate(() => {
        const checkbox = document.querySelector('.score-participation__consent input').getBoundingClientRect();
        const text = document.querySelector('.score-participation__consent span').getBoundingClientRect();
        const buttons = [...document.querySelectorAll('.score-participation > button')].map(button => {
            const rect = button.getBoundingClientRect();
            return { x: rect.x, width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom,
                textAlign: getComputedStyle(button).textAlign };
        });
        const deleteButton = document.querySelector('.manage-account__submit').getBoundingClientRect();
        return { checkboxWidth: checkbox.width, checkboxHeight: checkbox.height,
            gap: text.left - checkbox.right, overflow: document.documentElement.scrollWidth - innerWidth,
            buttons, deleteWidth: deleteButton.width, deleteHeight: deleteButton.height };
    });
    assert.ok(geometry.checkboxWidth >= 20 && geometry.checkboxHeight >= 20, JSON.stringify(geometry));
    assert.ok(geometry.gap >= 8 && geometry.overflow <= 1, JSON.stringify(geometry));
    assert.ok(geometry.buttons.length >= 3, JSON.stringify(geometry));
    for (const [index, button] of geometry.buttons.entries()) {
        assert.ok(Math.abs(button.width - geometry.deleteWidth) <= 1 && button.height >= 44 && geometry.deleteHeight >= 44, JSON.stringify(geometry));
        assert.equal(button.textAlign, 'center');
        if (index) assert.ok(button.top - geometry.buttons[index - 1].bottom >= 8, JSON.stringify(geometry));
    }
    await choice.check();
    assert.equal(await join.isEnabled(), true);
    assert.equal(calls.filter(call => call.path === '/auth/parent-registration/scores/publish').length, 0);
});

for (const mode of ['withdraw-child','delete-family']) test(`navigation prevents ${mode} approval and destructive send`, async t => {
    const {page,calls,external,cancelled} = await fixture(t);
    if (mode === 'withdraw-child') {
        await page.locator('section[aria-label="Manage child accounts"] select').selectOption(children[0]);
        await page.locator('summary').filter({hasText:'Delete this child account'}).click();
        await page.getByLabel('Type WITHDRAW AND DELETE').fill('WITHDRAW AND DELETE');
        await page.getByRole('button',{name:'Confirm deletion with Apple'}).click();
    } else {
        await page.locator('summary').filter({hasText:'Delete your family accounts'}).click();
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
    await page.locator('summary').filter({hasText:'Public leaderboards'}).click();
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
