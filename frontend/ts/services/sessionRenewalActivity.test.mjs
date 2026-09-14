import assert from 'node:assert/strict';
import test from 'node:test';
import { SESSION_RENEWAL_INTERVAL_MS, SESSION_RENEWAL_RETRY_MS, watchSessionRenewalActivity } from './sessionRenewalActivity.ts';

function eventSource() {
    const listeners = new Map();
    return {
        addEventListener(type, listener) { listeners.set(type, listener); },
        removeEventListener(type, listener) {
            if (listeners.get(type) === listener) listeners.delete(type);
        },
        dispatch(type, isTrusted = true) { listeners.get(type)?.({ type, isTrusted }); },
        get count() { return listeners.size; },
    };
}

function setup(renew = async () => true) {
    const windowEvents = eventSource();
    const documentEvents = eventSource();
    const state = { time: 0, visible: true, signedIn: true, calls: 0 };
    const watcher = watchSessionRenewalActivity({
        windowEvents,
        documentEvents,
        isVisible: () => state.visible,
        canRenew: () => state.signedIn,
        now: () => state.time,
        renew: async () => { state.calls++; return await renew(); },
    });
    return { state, watcher, windowEvents, documentEvents };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('an open, inactive tab never renews by the passage of time alone', async () => {
    const { state, watcher } = setup();
    state.time = 60 * 24 * 60 * 60 * 1000;
    await flush();
    assert.equal(state.calls, 0);
    watcher.stop();
});

test('real foreground activity renews at most once per fifteen minutes', async () => {
    const { state, watcher, windowEvents } = setup();
    windowEvents.dispatch('pointerdown');
    state.time = SESSION_RENEWAL_INTERVAL_MS - 1;
    windowEvents.dispatch('keydown');
    await flush();
    assert.equal(state.calls, 0, 'fresh login or startup has its own check');
    state.time++;
    for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'focus']) windowEvents.dispatch(type);
    await flush();
    assert.equal(state.calls, 1);
    state.time += SESSION_RENEWAL_INTERVAL_MS;
    windowEvents.dispatch('keydown');
    await flush();
    assert.equal(state.calls, 2);
    watcher.stop();
});

test('hidden, synthetic and confirmed signed-out activity cannot extend a session', async () => {
    const { state, watcher, windowEvents, documentEvents } = setup();
    state.time = SESSION_RENEWAL_INTERVAL_MS;
    windowEvents.dispatch('pointermove', false);
    state.visible = false;
    windowEvents.dispatch('keydown');
    documentEvents.dispatch('visibilitychange');
    state.visible = true;
    state.signedIn = false;
    windowEvents.dispatch('focus');
    await flush();
    assert.equal(state.calls, 0);
    state.signedIn = true;
    documentEvents.dispatch('visibilitychange');
    await flush();
    assert.equal(state.calls, 1);
    watcher.stop();
});

test('foreground return is throttled and successful login resets its cooldown', async () => {
    const { state, watcher, windowEvents, documentEvents } = setup();
    state.time = SESSION_RENEWAL_INTERVAL_MS;
    watcher.resetCooldown();
    documentEvents.dispatch('visibilitychange');
    windowEvents.dispatch('focus');
    await flush();
    assert.equal(state.calls, 0);
    state.time += SESSION_RENEWAL_INTERVAL_MS;
    windowEvents.dispatch('focus');
    await flush();
    assert.equal(state.calls, 1);
    documentEvents.dispatch('visibilitychange');
    await flush();
    assert.equal(state.calls, 1);
    watcher.stop();
});

test('renewals cannot overlap even if one request lasts longer than the cooldown', async () => {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const { state, watcher, windowEvents } = setup(async () => { await blocked; return true; });
    state.time = SESSION_RENEWAL_INTERVAL_MS;
    windowEvents.dispatch('pointerdown');
    await flush();
    state.time += SESSION_RENEWAL_INTERVAL_MS;
    windowEvents.dispatch('keydown');
    await flush();
    assert.equal(state.calls, 1);
    release();
    await flush();
    windowEvents.dispatch('keydown');
    await flush();
    assert.equal(state.calls, 2);
    watcher.stop();
});

test('network failure is retried only on later activity, within the predecessor grace period', async () => {
    const { state, watcher, windowEvents } = setup(async () => { throw new Error('offline'); });
    state.time = SESSION_RENEWAL_INTERVAL_MS;
    windowEvents.dispatch('pointerdown');
    await flush();
    for (let index = 0; index < 20; index++) windowEvents.dispatch('pointermove');
    await flush();
    assert.equal(state.calls, 1);
    state.time += SESSION_RENEWAL_RETRY_MS - 1;
    windowEvents.dispatch('keydown');
    await flush();
    assert.equal(state.calls, 1);
    state.time++;
    windowEvents.dispatch('keydown');
    await flush();
    assert.equal(state.calls, 2);
    watcher.stop();
});

test('a lost startup response can recover its rotation before the two-minute predecessor grace expires', async () => {
    let responseReceived = false;
    const { state, watcher, windowEvents } = setup(async () => responseReceived);
    await watcher.renewNow();
    assert.equal(state.calls, 1);
    state.time = SESSION_RENEWAL_RETRY_MS;
    await flush();
    assert.equal(state.calls, 1, 'elapsed time alone cannot keep a session alive');
    responseReceived = true;
    windowEvents.dispatch('pointerdown');
    await flush();
    assert.equal(state.calls, 2);
    assert.ok(state.time < 120_000, 'retry still carries a recoverable predecessor');
    state.time += SESSION_RENEWAL_RETRY_MS;
    windowEvents.dispatch('pointermove');
    await flush();
    assert.equal(state.calls, 2, 'successful recovery restores the ordinary 15-minute interval');
    watcher.stop();
});

test('unmount removes every listener and prevents further renewals', async () => {
    const { state, watcher, windowEvents, documentEvents } = setup();
    assert.equal(windowEvents.count, 5);
    assert.equal(documentEvents.count, 1);
    watcher.stop();
    assert.equal(windowEvents.count, 0);
    assert.equal(documentEvents.count, 0);
    state.time = SESSION_RENEWAL_INTERVAL_MS;
    windowEvents.dispatch('keydown');
    documentEvents.dispatch('visibilitychange');
    await flush();
    assert.equal(state.calls, 0);
});

test('unmount also cancels an activity attempt queued in the current event turn', async () => {
    const { state, watcher, windowEvents } = setup();
    state.time = SESSION_RENEWAL_INTERVAL_MS;
    windowEvents.dispatch('pointerdown');
    watcher.stop();
    await flush();
    assert.equal(state.calls, 0);
});
