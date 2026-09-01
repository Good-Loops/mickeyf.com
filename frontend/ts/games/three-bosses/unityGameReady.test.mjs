import assert from 'node:assert/strict';
import test from 'node:test';
import {
    bindThreeBossesGameReady,
    handOffThreeBossesCanvas,
    THREE_BOSSES_GAME_READY_TIMEOUT_MS,
} from './unityGameReady.ts';

const createClock = () => {
    const scheduled = new Map();
    let nextId = 1;

    return {
        clock: {
            schedule: (callback, delayMs) => {
                const id = nextId++;
                scheduled.set(id, { callback, delayMs });
                return id;
            },
            cancel: (id) => scheduled.delete(id),
        },
        scheduled,
    };
};

test('does not spend the menu-readiness timeout during Unity loading', async () => {
    const controller = new AbortController();
    const readyWindow = {};
    const { clock, scheduled } = createClock();
    const binding = bindThreeBossesGameReady(
        controller.signal,
        readyWindow,
        clock,
    );

    assert.equal(scheduled.size, 0);

    readyWindow.mickeyfThreeBossesSignalReady();
    binding.startTimeout();

    await binding.promise;
    assert.equal(scheduled.size, 0);
    assert.equal(readyWindow.mickeyfThreeBossesSignalReady, undefined);
});

test('starts a bounded readiness deadline only when requested', async () => {
    const controller = new AbortController();
    const readyWindow = {};
    const { clock, scheduled } = createClock();
    const binding = bindThreeBossesGameReady(
        controller.signal,
        readyWindow,
        clock,
    );

    binding.startTimeout();

    assert.equal(scheduled.size, 1);
    const [{ callback, delayMs }] = scheduled.values();
    assert.equal(delayMs, THREE_BOSSES_GAME_READY_TIMEOUT_MS);
    callback();

    await assert.rejects(
        binding.promise,
        /main menu did not become ready in time/,
    );
    assert.equal(readyWindow.mickeyfThreeBossesSignalReady, undefined);
});

test('aborting rejects the pending readiness wait and clears its timer', async () => {
    const controller = new AbortController();
    const readyWindow = {};
    const { clock, scheduled } = createClock();
    const binding = bindThreeBossesGameReady(
        controller.signal,
        readyWindow,
        clock,
    );

    binding.startTimeout();
    controller.abort();

    await assert.rejects(binding.promise, { name: 'AbortError' });
    assert.equal(scheduled.size, 0);
    assert.equal(readyWindow.mickeyfThreeBossesSignalReady, undefined);
});

test('an early abort remains observable after the readiness consumer attaches later', async () => {
    const controller = new AbortController();
    const readyWindow = {};
    const { clock } = createClock();
    const binding = bindThreeBossesGameReady(
        controller.signal,
        readyWindow,
        clock,
    );

    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));

    await assert.rejects(binding.promise, { name: 'AbortError' });
    assert.equal(readyWindow.mickeyfThreeBossesSignalReady, undefined);
});

test('yields the canvas before waiting for the post-splash menu frame', async () => {
    const events = [];
    let resolveMenuReady;
    let startupSettled = false;
    const menuReady = new Promise((resolve) => {
        resolveMenuReady = resolve;
    });
    const binding = {
        promise: menuReady,
        startTimeout: () => events.push('timeout-started'),
        release() {},
    };

    const startup = handOffThreeBossesCanvas(
        binding,
        () => events.push('canvas-owned'),
    ).then(() => {
        startupSettled = true;
    });

    assert.deepEqual(events, ['canvas-owned', 'timeout-started']);
    await Promise.resolve();
    assert.equal(startupSettled, false);

    resolveMenuReady();
    await startup;
    assert.equal(startupSettled, true);
});
