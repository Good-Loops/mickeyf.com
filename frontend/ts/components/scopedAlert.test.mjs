import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const viteServer = await createViteTestServer({
    root: frontendRoot,
    configFile: `${frontendRoot}/vite.config.ts`,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
});
after(() => viteServer.close());
const { showScopedAlert } = await viteServer.ssrLoadModule('/ts/components/scopedAlert.ts');
const { default: alert } = await viteServer.ssrLoadModule('/ts/components/siteAlert.ts');

function pendingPopup(t, { delayedOpen = false } = {}) {
    const popup = {};
    let currentPopup = popup;
    let options;
    let finish;
    const close = t.mock.method(alert, 'close', () => finish({}));
    t.mock.method(alert, 'getPopup', () => currentPopup);
    t.mock.method(alert, 'fire', incoming => new Promise(resolve => {
        options = incoming;
        finish = resolve;
        if (!delayedOpen) options.didOpen(popup);
    }));
    return {
        popup,
        close,
        open: () => options.didOpen(popup),
        finish: () => finish({}),
        replace: () => { currentPopup = {}; },
    };
}

test('feedback without a lifetime signal retains the ordinary alert options', async t => {
    const options = { title: 'Welcome back!', didOpen() {} };
    const fire = t.mock.method(alert, 'fire', async incoming => {
        assert.equal(incoming, options);
        return { isConfirmed: true };
    });
    assert.equal(await showScopedAlert(options), undefined);
    assert.equal(fire.mock.callCount(), 1);
});

test('an already-aborted lifetime never opens feedback', async t => {
    const controller = new AbortController();
    controller.abort();
    const fire = t.mock.method(alert, 'fire', () => assert.fail('inactive feedback cannot open'));
    await showScopedAlert({ title: 'Late result' }, controller.signal);
    assert.equal(fire.mock.callCount(), 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('leaving while feedback is open closes the owned popup and releases its listener', async t => {
    const controller = new AbortController();
    const popup = pendingPopup(t);
    const opened = [];
    const pending = showScopedAlert({ title: 'Result', didOpen: element => opened.push(element) }, controller.signal);
    assert.deepEqual(opened, [popup.popup]);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    controller.abort();
    await pending;
    assert.equal(popup.close.mock.callCount(), 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('an old route cannot close a replacement popup', async t => {
    const controller = new AbortController();
    const popup = pendingPopup(t);
    const pending = showScopedAlert({ title: 'Old result' }, controller.signal);
    popup.replace();
    controller.abort();
    assert.equal(popup.close.mock.callCount(), 0);
    popup.finish();
    await pending;
});

test('leaving before delayed didOpen closes feedback when ownership becomes known', async t => {
    const controller = new AbortController();
    const popup = pendingPopup(t, { delayedOpen: true });
    const pending = showScopedAlert({ didOpen: () => assert.fail('inactive callback cannot run') }, controller.signal);
    controller.abort();
    assert.equal(popup.close.mock.callCount(), 0);
    popup.open();
    await pending;
    assert.equal(popup.close.mock.callCount(), 1);
});

test('a delayed didOpen cannot close feedback that replaced its popup', async t => {
    const controller = new AbortController();
    const popup = pendingPopup(t, { delayedOpen: true });
    const pending = showScopedAlert({ title: 'Old result' }, controller.signal);
    controller.abort();
    popup.replace();
    popup.open();
    assert.equal(popup.close.mock.callCount(), 0);
    popup.finish();
    await pending;
});

test('ordinary dismissal removes the abort listener before later route departure', async t => {
    const controller = new AbortController();
    const popup = pendingPopup(t);
    const pending = showScopedAlert({ title: 'Result' }, controller.signal);
    popup.finish();
    await pending;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    controller.abort();
    assert.equal(popup.close.mock.callCount(), 0);
});

test('an alert failure also releases the abort listener and remains a rejection', async t => {
    const controller = new AbortController();
    const failure = new Error('Synthetic alert failure');
    t.mock.method(alert, 'fire', () => { throw failure; });
    await assert.rejects(showScopedAlert({ title: 'Result' }, controller.signal), failure);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
