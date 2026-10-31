import assert from 'node:assert/strict';
import test from 'node:test';
import { watchChildOnlineActivity } from './childOnlineActivity.ts';

function setup(report = async () => true) {
    const listeners = new Map();
    const state = { visible: true, authenticated: true, now: 0, calls: 0 };
    const events = { addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); },
        fire(type, trusted = true) { listeners.get(type)?.({ isTrusted: trusted }); } };
    const stop = watchChildOnlineActivity({ events, isVisible: () => state.visible, canReport: () => state.authenticated,
        now: () => state.now, async report() { state.calls++; return report(); } });
    return { events, state, stop, listeners };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('only trusted foreground input while signed in reports online activity, at most hourly', async () => {
    const f = setup();
    f.state.now = 5_000_000; await flush(); assert.equal(f.state.calls, 0, 'time alone does not report');
    f.events.fire('pointerdown', false); f.state.visible = false; f.events.fire('touchstart');
    f.state.visible = true; f.state.authenticated = false; f.events.fire('keydown'); await flush(); assert.equal(f.state.calls, 0);
    f.state.authenticated = true; f.events.fire('touchstart'); await flush(); assert.equal(f.state.calls, 1);
    f.events.fire('pointermove'); await flush(); assert.equal(f.state.calls, 1);
    f.state.now += 60 * 60_000; f.events.fire('pointermove'); await flush(); assert.equal(f.state.calls, 2);
    f.stop(); assert.equal(f.listeners.size, 0); f.events.fire('keydown'); await flush(); assert.equal(f.state.calls, 2);
});

test('offline reports retry only on later input, and stop cancels a queued report', async () => {
    const f = setup(async () => { throw new Error('offline'); });
    f.events.fire('keydown'); await flush(); assert.equal(f.state.calls, 1);
    f.state.now += 59_999; f.events.fire('pointerdown'); await flush(); assert.equal(f.state.calls, 1);
    f.state.now++; f.events.fire('pointerdown'); await flush(); assert.equal(f.state.calls, 2); f.stop();
    const g = setup(); g.events.fire('pointerdown'); g.stop(); await flush(); assert.equal(g.state.calls, 0);
});

test('untracked sessions send only one report until the account session changes', async () => {
    const f = setup(async () => 'not-tracked');
    f.events.fire('pointerdown'); await flush(); assert.equal(f.state.calls, 1);
    f.state.now += 5 * 60 * 60_000; f.events.fire('keydown'); await flush(); assert.equal(f.state.calls, 1);
    f.stop();
});
