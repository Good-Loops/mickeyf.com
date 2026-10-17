import assert from 'node:assert/strict';
import test from 'node:test';
import { trackNavigationIndicator } from './navigationIndicator.ts';

class Events {
    listeners = new Map();
    addEventListener(type, callback) {
        const callbacks = this.listeners.get(type) ?? new Set();
        callbacks.add(callback); this.listeners.set(type, callbacks);
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    fire(type, target) { this.listeners.get(type)?.forEach(callback => callback({ target })); }
    get listenerCount() { return [...this.listeners.values()].reduce((count, callbacks) => count + callbacks.size, 0); }
}
class ElementFixture extends Events {
    focusVisible = false;
    active = false;
    groupActive = false;
    dataset = {};
    properties = new Map();
    style = { setProperty: (name, value) => this.properties.set(name, value) };
    classList = { contains: name => name === 'nav__link--group-active' && this.groupActive };
    closest() { return this.item; }
    querySelector() { return this.link; }
    getAttribute(name) { return name === 'aria-current' && this.active ? 'page' : null; }
    matches(selector) { assert.equal(selector, ':focus-visible'); return this.focusVisible; }
    getBoundingClientRect() { return { ...this.bounds, right: this.bounds.left + this.bounds.width, bottom: this.bounds.top + this.bounds.height }; }
}

function fixture(t, active = 2) {
    const originals = new Map(['Element', 'ResizeObserver'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    let observer;
    class Observer {
        observed = new Set();
        disconnected = false;
        constructor(callback) { this.callback = callback; observer = this; }
        observe(element) { this.observed.add(element); }
        disconnect() { this.disconnected = true; this.observed.clear(); }
    }
    Object.defineProperty(globalThis, 'Element', { configurable: true, value: ElementFixture });
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: Observer });
    const view = new Events();
    const frames = new Map(); let nextFrame = 0;
    view.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
    view.cancelAnimationFrame = id => frames.delete(id);
    const document = { defaultView: view, activeElement: null };
    const navigation = new ElementFixture(); navigation.ownerDocument = document;
    const links = [0, 1, 2, 3].map(index => {
        const link = new ElementFixture(); const item = new ElementFixture();
        link.bounds = { left: 108 + index * 76, top: 24, width: 72, height: 32 };
        link.item = item; item.link = link; link.active = index === active;
        return link;
    });
    navigation.querySelectorAll = () => links;
    navigation.contains = element => links.some(link => link === element || link.item === element);
    const track = new ElementFixture(); track.bounds = { left: 104, top: 22, width: 308, height: 36 };
    const slider = new ElementFixture();
    const stop = trackNavigationIndicator(navigation, track, slider);
    t.after(() => { stop(); originals.forEach((descriptor, name) => {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }); });
    const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
    const position = () => Object.fromEntries([...slider.properties].map(([name, value]) => [name, parseFloat(value)]));
    return { navigation, links, track, slider, document, view, observer, frames, flush, position, stop };
}

test('the shared slider follows nested pointer targets and returns to the active route on leave', t => {
    const f = fixture(t);
    assert.equal(f.position()['--nav-indicator-x'], 156);
    assert.equal(f.track.dataset.visible, 'true');
    const chevron = new ElementFixture(); chevron.item = f.links[3].item;
    for (let move = 0; move < 5; move++) f.navigation.fire('pointermove', chevron);
    assert.equal(f.frames.size, 1, 'pointer movement shares one layout read per frame');
    f.flush(); assert.equal(f.position()['--nav-indicator-x'], 232);
    f.navigation.fire('pointerleave'); f.flush();
    assert.equal(f.position()['--nav-indicator-x'], 156);
});

test('keyboard focus takes over from hover and dropdown focus keeps its parent highlighted', async t => {
    const f = fixture(t);
    f.navigation.fire('pointerover', f.links[0]); f.flush();
    const submenu = new ElementFixture(); submenu.item = f.links[3].item; submenu.focusVisible = true;
    f.document.activeElement = submenu; f.navigation.fire('focusin', submenu); f.flush();
    assert.equal(f.position()['--nav-indicator-x'], 232);
    f.navigation.fire('pointerleave'); f.flush();
    assert.equal(f.position()['--nav-indicator-x'], 232);
    f.document.activeElement = null; f.navigation.fire('focusout', submenu);
    await Promise.resolve(); f.flush();
    assert.equal(f.position()['--nav-indicator-x'], 156);
});

test('resize and scroll remeasure the indicator and clamp every edge inside its inset track', t => {
    const f = fixture(t);
    assert.equal(f.observer.observed.size, 5);
    f.links[2].bounds = { left: 90, top: 15, width: 400, height: 80 };
    f.track.bounds = { left: 110, top: 25, width: 210, height: 25 };
    f.observer.callback(); f.flush();
    assert.deepEqual(Object.values(f.position()), [0, 0, 210, 25]);
    f.links[2].bounds = { left: 130, top: 26, width: 50, height: 20 };
    f.view.fire('scroll'); f.flush();
    assert.deepEqual(Object.values(f.position()), [20, 1, 50, 20]);
    f.links[2].bounds.left = 150; f.view.fire('resize'); f.flush();
    assert.equal(f.position()['--nav-indicator-x'], 40);
});

test('routes without a selected top-level group hide the slider after hover ends', t => {
    const f = fixture(t, -1);
    assert.equal(f.track.dataset.visible, 'false');
    f.links[1].groupActive = true; f.view.fire('resize'); f.flush();
    assert.equal(f.track.dataset.visible, 'true');
    assert.equal(f.position()['--nav-indicator-x'], 80);
    f.links[1].groupActive = false; f.navigation.fire('pointerover', f.links[0]); f.flush();
    assert.equal(f.track.dataset.visible, 'true');
    f.navigation.fire('pointerleave'); f.flush();
    assert.equal(f.track.dataset.visible, 'false');
});

test('teardown disconnects observers, listeners and queued animation work', async t => {
    const f = fixture(t);
    f.navigation.fire('pointermove', f.links[3]);
    f.navigation.fire('focusout');
    const before = f.position(); f.stop();
    await Promise.resolve(); f.flush();
    assert.equal(f.navigation.listenerCount, 0);
    assert.equal(f.view.listenerCount, 0);
    assert.equal(f.observer.disconnected, true);
    assert.equal(f.frames.size, 0);
    assert.deepEqual(f.position(), before);
});
