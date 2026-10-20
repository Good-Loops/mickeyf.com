import assert from 'node:assert/strict';
import test from 'node:test';
import { bindUnityPageScroll } from './unityPageScroll.ts';

function fixture() {
    const scrolls = [];
    const state = { overflowY: 'auto', fallback: null };
    const wrapper = { getAttribute: () => state.fallback };
    const browser = {
        scrollBy: options => scrolls.push(options),
        getComputedStyle: () => state,
    };
    const page = { defaultView: browser, documentElement: {}, fullscreenElement: null };
    const canvas = {
        ownerDocument: page, isConnected: true,
        closest: () => wrapper,
        getBoundingClientRect: () => ({ height: 200 }),
    };
    return { canvas, browser, wrapper, page, scrolls, state };
}

test('Unity drag distance scales to the displayed canvas, not the render resolution', () => {
    const f = fixture();
    bindUnityPageScroll(f.canvas);
    f.browser.MickeyfThreeBossesScrollPage(0.25);
    f.browser.MickeyfThreeBossesScrollPage(-0.1);
    assert.deepEqual(f.scrolls, [{ top: 50, behavior: 'instant' }, { top: -20, behavior: 'instant' }]);
});

test('native, prefixed and fallback fullscreen do not move the page', () => {
    for (const mode of ['fullscreenElement', 'webkitFullscreenElement', 'fallback']) {
        const f = fixture();
        bindUnityPageScroll(f.canvas);
        if (mode === 'fallback') f.state.fallback = 'fallback';
        else f.page[mode] = f.wrapper;
        f.browser.MickeyfThreeBossesScrollPage(0.25);
        assert.equal(f.scrolls.length, 0, mode);
    }
});

test('scrollable ancestors consume their distance before the document scrolls', () => {
    const f = fixture();
    const ancestor = { scrollTop: 20, scrollHeight: 200, clientHeight: 160, parentElement: f.page.documentElement };
    f.canvas.parentElement = ancestor;
    bindUnityPageScroll(f.canvas);
    f.browser.MickeyfThreeBossesScrollPage(0.25);
    assert.equal(ancestor.scrollTop, 40);
    assert.deepEqual(f.scrolls, [{ top: 30, behavior: 'instant' }]);
    f.browser.MickeyfThreeBossesScrollPage(-0.1);
    assert.equal(ancestor.scrollTop, 20);
    assert.equal(f.scrolls.length, 1);
});

test('locked pages, detached canvases and invalid deltas are ignored', () => {
    const f = fixture();
    bindUnityPageScroll(f.canvas);
    for (const value of [NaN, Infinity, -Infinity, 1.1, -1.1]) f.browser.MickeyfThreeBossesScrollPage(value);
    for (const overflow of ['hidden', 'clip']) {
        f.state.overflowY = overflow;
        f.browser.MickeyfThreeBossesScrollPage(0.1);
    }
    f.state.overflowY = 'auto';
    f.canvas.isConnected = false;
    f.browser.MickeyfThreeBossesScrollPage(0.1);
    assert.equal(f.scrolls.length, 0);
});

test('a locked native document still allows its main scroll region without leaking the remainder', () => {
    for (const overflowY of ['hidden', 'clip']) {
        const f = fixture();
        const main = { scrollTop: 20, scrollHeight: 200, clientHeight: 160, parentElement: f.page.documentElement };
        f.canvas.parentElement = main;
        f.browser.getComputedStyle = element => ({ overflowY: element === main ? 'auto' : overflowY });
        bindUnityPageScroll(f.canvas);
        f.browser.MickeyfThreeBossesScrollPage(0.25);
        assert.equal(main.scrollTop, 40, overflowY);
        assert.equal(f.scrolls.length, 0, overflowY);
        f.browser.MickeyfThreeBossesScrollPage(-0.1);
        assert.equal(main.scrollTop, 20, overflowY);
        assert.equal(f.scrolls.length, 0, overflowY);
        f.page.fullscreenElement = f.wrapper;
        f.browser.MickeyfThreeBossesScrollPage(-0.1);
        assert.equal(main.scrollTop, 20, 'fullscreen must still keep the entire scroll chain stationary');
    }
});

test('disposal restores the previous callback and does not clear another owner', () => {
    const f = fixture();
    const prior = () => {};
    f.browser.MickeyfThreeBossesScrollPage = prior;
    const release = bindUnityPageScroll(f.canvas);
    release();
    assert.equal(f.browser.MickeyfThreeBossesScrollPage, prior);
    const releaseAgain = bindUnityPageScroll(f.canvas);
    f.browser.MickeyfThreeBossesScrollPage = prior;
    releaseAgain();
    assert.equal(f.browser.MickeyfThreeBossesScrollPage, prior);
    delete f.browser.MickeyfThreeBossesScrollPage;
    bindUnityPageScroll(f.canvas)();
    assert.equal('MickeyfThreeBossesScrollPage' in f.browser, false);
});
