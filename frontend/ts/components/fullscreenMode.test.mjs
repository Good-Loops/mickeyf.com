import assert from 'node:assert/strict';
import test from 'node:test';
import {
    CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE,
    CANVAS_FULLSCREEN_FALLBACK_VALUE,
    CANVAS_FULLSCREEN_ROOT_CLASS,
    clearCanvasFullscreenFallback,
    isCanvasFullscreen,
    toggleCanvasFullscreen,
} from './fullscreenMode.ts';

const createClassList = () => {
    const values = new Set();

    return {
        add: (value) => values.add(value),
        contains: (value) => values.has(value),
        remove: (value) => values.delete(value),
    };
};

const createElement = () => {
    const attributes = new Map();
    const styles = new Map();

    return {
        children: [],
        getAttribute: (name) => attributes.get(name) ?? null,
        hasAttribute: (name) => attributes.has(name),
        isConnected: true,
        parentElement: null,
        removeAttribute: (name) => attributes.delete(name),
        setAttribute: (name, value) => attributes.set(name, value),
        style: {
            getPropertyValue: (name) => styles.get(name)?.value ?? '',
            getPropertyPriority: (name) => styles.get(name)?.priority ?? '',
            setProperty: (name, value, priority = '') => styles.set(name, { value, priority }),
            removeProperty: (name) => styles.delete(name),
        },
    };
};

const createDocument = (targets) => {
    const listeners = new Map();

    return {
        addEventListener: (type, listener) => {
            const typeListeners = listeners.get(type) ?? new Set();
            typeListeners.add(listener);
            listeners.set(type, typeListeners);
        },
        dispatchEvent: (type) => {
            for (const listener of listeners.get(type) ?? []) listener();
        },
        documentElement: { ...createElement(), classList: createClassList() },
        defaultView: null,
        exitFullscreen: undefined,
        fullscreenElement: null,
        visibilityState: 'visible',
        listenerCount: (type) => listeners.get(type)?.size ?? 0,
        querySelector: (selector) => {
            assert.equal(
                selector,
                `[${CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE}="${CANVAS_FULLSCREEN_FALLBACK_VALUE}"]`,
            );
            return targets.find(
                (target) => target.getAttribute(CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE)
                    === CANVAS_FULLSCREEN_FALLBACK_VALUE,
            ) ?? null;
        },
        removeEventListener: (type, listener) => {
            listeners.get(type)?.delete(listener);
        },
    };
};

const createPaintClock = () => {
    const frames = new Map();
    const timers = new Map();
    let now = 0;
    let nextId = 1;

    return {
        requestAnimationFrame: (callback) => {
            const id = nextId++;
            frames.set(id, callback);
            return id;
        },
        cancelAnimationFrame: (id) => frames.delete(id),
        setTimeout: (callback, delay) => {
            const id = nextId++;
            timers.set(id, { callback, at: now + delay });
            return id;
        },
        clearTimeout: (id) => timers.delete(id),
        paintFrame: () => {
            const callbacks = [...frames.values()];
            frames.clear();
            for (const callback of callbacks) callback(now);
        },
        advanceTime: (milliseconds) => {
            now += milliseconds;
            for (const [id, { callback, at }] of [...timers]) {
                if (at > now) continue;
                timers.delete(id);
                callback();
            }
        },
        pendingWork: () => ({ frames: frames.size, timers: timers.size }),
    };
};

const createSafariPaintFixture = (additionalTargets = []) => {
    const target = createElement();
    const fullscreenDocument = createDocument([target, ...additionalTargets]);
    const clock = createPaintClock();
    fullscreenDocument.defaultView = clock;
    fullscreenDocument.documentElement.setAttribute('data-safari-edges', 'locked');
    return { target, fullscreenDocument, clock };
};

const assertPaintCleanup = (fullscreenDocument, clock) => {
    assert.deepEqual(clock.pendingWork(), { frames: 0, timers: 0 });
    assert.equal(fullscreenDocument.listenerCount('visibilitychange'), 0);
};

test('uses and reverses the viewport fallback when element fullscreen is unavailable', async () => {
    const target = createElement();
    const fullscreenDocument = createDocument([target]);

    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), true);
    assert.equal(isCanvasFullscreen(target, fullscreenDocument), true);
    assert.equal(
        target.getAttribute(CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE),
        CANVAS_FULLSCREEN_FALLBACK_VALUE,
    );
    assert.equal(
        fullscreenDocument.documentElement.classList.contains(CANVAS_FULLSCREEN_ROOT_CLASS),
        true,
    );

    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), false);
    assert.equal(isCanvasFullscreen(target, fullscreenDocument), false);
    assert.equal(target.getAttribute(CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE), null);
    assert.equal(
        fullscreenDocument.documentElement.classList.contains(CANVAS_FULLSCREEN_ROOT_CLASS),
        false,
    );
});

test('uses the standard Fullscreen API without applying the fallback', async () => {
    const target = createElement();
    const fullscreenDocument = createDocument([target]);
    let enterCalls = 0;
    let exitCalls = 0;

    target.requestFullscreen = async () => {
        enterCalls += 1;
        fullscreenDocument.fullscreenElement = target;
    };
    fullscreenDocument.exitFullscreen = async () => {
        exitCalls += 1;
        fullscreenDocument.fullscreenElement = null;
    };

    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), true);
    assert.equal(enterCalls, 1);
    assert.equal(target.getAttribute(CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE), null);

    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), false);
    assert.equal(exitCalls, 1);
});

test('installed iOS uses reversible in-app fullscreen even when WebKit exposes native fullscreen', async () => {
    const target = createElement();
    const sibling = createElement();
    target.parentElement = { children: [target, sibling] };
    const fullscreenDocument = createDocument([target]);
    fullscreenDocument.documentElement.setAttribute('data-native-app', 'ios');
    target.requestFullscreen = target.webkitRequestFullscreen = () => assert.fail('must not invoke WebKit presenter');

    for (let cycle = 0; cycle < 3; cycle += 1) {
        assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), true);
        assert.equal(target.getAttribute(CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE), CANVAS_FULLSCREEN_FALLBACK_VALUE);
        assert.equal(sibling.hasAttribute('inert'), true);
        assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), false);
        assert.equal(sibling.hasAttribute('inert'), false);
        assert.equal(fullscreenDocument.documentElement.classList.contains(CANVAS_FULLSCREEN_ROOT_CLASS), false);
    }
});

test('Android app keeps the browser native fullscreen path', async () => {
    const target = createElement();
    const fullscreenDocument = createDocument([target]);
    fullscreenDocument.documentElement.setAttribute('data-native-app', 'android');
    target.requestFullscreen = () => { fullscreenDocument.fullscreenElement = target; };
    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), true);
    assert.equal(target.getAttribute(CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE), null);
});

test('supports prefixed WebKit fullscreen used by older iPads', async () => {
    const target = createElement();
    const fullscreenDocument = createDocument([target]);

    target.webkitRequestFullscreen = async () => {
        fullscreenDocument.webkitFullscreenElement = target;
    };
    fullscreenDocument.webkitExitFullscreen = async () => {
        fullscreenDocument.webkitFullscreenElement = null;
    };

    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), true);
    assert.equal(isCanvasFullscreen(target, fullscreenDocument), true);
    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), false);
});

test('falls back when a prefixed WebKit request silently fails to enter fullscreen', async () => {
    const target = createElement();
    const fullscreenDocument = createDocument([target]);

    target.webkitRequestFullscreen = () => {};

    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument, 0), true);
    assert.equal(isCanvasFullscreen(target, fullscreenDocument), true);
    assert.equal(
        target.getAttribute(CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE),
        CANVAS_FULLSCREEN_FALLBACK_VALUE,
    );
});

test('does not enable the fallback after its target disconnects while awaiting confirmation', async () => {
    const target = createElement();
    const fullscreenDocument = createDocument([target]);

    target.webkitRequestFullscreen = () => {
        setTimeout(() => {
            target.isConnected = false;
        }, 0);
    };

    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument, 10), false);
    assert.equal(target.getAttribute(CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE), null);
    assert.equal(
        fullscreenDocument.documentElement.classList.contains(CANVAS_FULLSCREEN_ROOT_CLASS),
        false,
    );
});

test('late prefixed fullscreen replaces its temporary viewport fallback', async () => {
    const target = createElement();
    const fullscreenDocument = createDocument([target]);
    let exitCalls = 0;

    target.webkitRequestFullscreen = () => {};
    fullscreenDocument.webkitExitFullscreen = () => {
        exitCalls += 1;
        fullscreenDocument.webkitFullscreenElement = null;
    };

    await toggleCanvasFullscreen(target, fullscreenDocument, 0);
    assert.equal(isCanvasFullscreen(target, fullscreenDocument), true);
    assert.equal(
        target.getAttribute(CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE),
        CANVAS_FULLSCREEN_FALLBACK_VALUE,
    );

    fullscreenDocument.webkitFullscreenElement = target;
    fullscreenDocument.dispatchEvent('webkitfullscreenchange');

    assert.equal(target.getAttribute(CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE), null);
    assert.equal(isCanvasFullscreen(target, fullscreenDocument), true);
    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), false);
    assert.equal(exitCalls, 1);
});

test('falls back for an explicitly unsupported native request', async () => {
    const target = createElement();
    const fullscreenDocument = createDocument([target]);

    target.requestFullscreen = async () => {
        const error = new Error('Unsupported');
        error.name = 'NotSupportedError';
        throw error;
    };

    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), true);
    assert.equal(isCanvasFullscreen(target, fullscreenDocument), true);
});

test('does not enable the fallback when an unsupported request rejects after disconnection', async () => {
    const target = createElement();
    const fullscreenDocument = createDocument([target]);

    target.requestFullscreen = async () => {
        target.isConnected = false;
        const error = new Error('Unsupported');
        error.name = 'NotSupportedError';
        throw error;
    };

    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), false);
    assert.equal(target.getAttribute(CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE), null);
    assert.equal(
        fullscreenDocument.documentElement.classList.contains(CANVAS_FULLSCREEN_ROOT_CLASS),
        false,
    );
});

test('does not hide a native permission denial behind the CSS fallback', async () => {
    const target = createElement();
    const fullscreenDocument = createDocument([target]);

    target.requestFullscreen = async () => {
        const error = new Error('Denied');
        error.name = 'NotAllowedError';
        throw error;
    };

    await assert.rejects(
        toggleCanvasFullscreen(target, fullscreenDocument),
        (error) => error.name === 'NotAllowedError',
    );
    assert.equal(target.getAttribute(CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE), null);
});

test('does not hide an invalid native request TypeError behind the CSS fallback', async () => {
    const target = createElement();
    const fullscreenDocument = createDocument([target]);

    target.requestFullscreen = async () => {
        throw new TypeError('The element is disconnected.');
    };

    await assert.rejects(
        toggleCanvasFullscreen(target, fullscreenDocument),
        TypeError,
    );
    assert.equal(target.getAttribute(CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE), null);
});

test('cleanup removes fallback state from the target and document root', async () => {
    const target = createElement();
    const fullscreenDocument = createDocument([target]);

    await toggleCanvasFullscreen(target, fullscreenDocument);
    clearCanvasFullscreenFallback(target, fullscreenDocument);

    assert.equal(isCanvasFullscreen(target, fullscreenDocument), false);
    assert.equal(
        fullscreenDocument.documentElement.classList.contains(CANVAS_FULLSCREEN_ROOT_CLASS),
        false,
    );
});

test('fallback isolates background controls and restores their prior inert state', async () => {
    const target = createElement();
    const sibling = createElement();
    const parent = createElement();
    parent.children = [target, sibling];
    target.parentElement = parent;
    sibling.parentElement = parent;
    const fullscreenDocument = createDocument([target]);

    await toggleCanvasFullscreen(target, fullscreenDocument);
    assert.equal(sibling.hasAttribute('inert'), true);

    clearCanvasFullscreenFallback(target, fullscreenDocument);
    assert.equal(sibling.hasAttribute('inert'), false);
});

test('overlapping fallback entries do not leave navigation inert after exit', async () => {
    const target = createElement();
    const header = createElement();
    const alreadyInert = createElement();
    alreadyInert.setAttribute('inert', '');
    target.parentElement = { children: [target, header, alreadyInert] };
    target.webkitRequestFullscreen = () => {};
    const fullscreenDocument = createDocument([target]);

    await Promise.all([
        toggleCanvasFullscreen(target, fullscreenDocument, 0),
        toggleCanvasFullscreen(target, fullscreenDocument, 0),
    ]);
    assert.equal(header.hasAttribute('inert'), true);
    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), false);
    assert.equal(header.hasAttribute('inert'), false);
    assert.equal(alreadyInert.hasAttribute('inert'), true);
    assert.equal(fullscreenDocument.listenerCount('webkitfullscreenchange'), 0);
});

test('stale cleanup cannot remove the root lock from a replacement fallback', async () => {
    const firstTarget = createElement();
    const secondTarget = createElement();
    const fullscreenDocument = createDocument([firstTarget, secondTarget]);

    await toggleCanvasFullscreen(firstTarget, fullscreenDocument);
    await toggleCanvasFullscreen(secondTarget, fullscreenDocument);
    clearCanvasFullscreenFallback(firstTarget, fullscreenDocument);

    assert.equal(isCanvasFullscreen(secondTarget, fullscreenDocument), true);
    assert.equal(
        fullscreenDocument.documentElement.classList.contains(CANVAS_FULLSCREEN_ROOT_CLASS),
        true,
    );

    clearCanvasFullscreenFallback(secondTarget, fullscreenDocument);
    assert.equal(
        fullscreenDocument.documentElement.classList.contains(CANVAS_FULLSCREEN_ROOT_CLASS),
        false,
    );
});

test('Safari fallback exit offers one hidden frame without detaching or resizing the canvas', async () => {
    const { target, fullscreenDocument, clock } = createSafariPaintFixture();
    const sibling = createElement();
    const parent = createElement();
    parent.children = [target, sibling];
    target.parentElement = parent;
    target.style.setProperty('display', 'flex');
    target.style.setProperty('width', '640px');

    await toggleCanvasFullscreen(target, fullscreenDocument);
    assert.equal(sibling.hasAttribute('inert'), true);
    let settled = false;
    const exit = toggleCanvasFullscreen(target, fullscreenDocument);
    exit.then(() => { settled = true; });

    assert.equal(isCanvasFullscreen(target, fullscreenDocument), false);
    assert.equal(fullscreenDocument.documentElement.classList.contains(CANVAS_FULLSCREEN_ROOT_CLASS), false);
    assert.equal(sibling.hasAttribute('inert'), false);
    assert.equal(target.style.getPropertyValue('visibility'), 'hidden');
    assert.equal(target.style.getPropertyPriority('visibility'), 'important');
    assert.equal(target.style.getPropertyValue('display'), 'flex');
    assert.equal(target.style.getPropertyValue('width'), '640px');
    assert.equal(target.parentElement, parent);
    assert.equal(target.isConnected, true);

    clock.paintFrame();
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(target.style.getPropertyValue('visibility'), 'hidden');
    clock.paintFrame();
    assert.equal(await exit, false);
    assert.equal(target.style.getPropertyValue('visibility'), '');
    assert.equal(target.style.getPropertyPriority('visibility'), '');
    assertPaintCleanup(fullscreenDocument, clock);
});

test('Safari paint restoration preserves the original inline visibility and priority', async () => {
    for (const priority of ['', 'important']) {
        const { target, fullscreenDocument, clock } = createSafariPaintFixture();
        target.style.setProperty('visibility', 'visible', priority);
        await toggleCanvasFullscreen(target, fullscreenDocument);
        const exit = toggleCanvasFullscreen(target, fullscreenDocument);

        clock.paintFrame();
        clock.paintFrame();
        assert.equal(await exit, false);
        assert.equal(target.style.getPropertyValue('visibility'), 'visible');
        assert.equal(target.style.getPropertyPriority('visibility'), priority);
        assertPaintCleanup(fullscreenDocument, clock);
    }
});

test('Safari paint restoration has a bounded deadline when frames do not arrive', async () => {
    const { target, fullscreenDocument, clock } = createSafariPaintFixture();
    await toggleCanvasFullscreen(target, fullscreenDocument);
    const exit = toggleCanvasFullscreen(target, fullscreenDocument);

    clock.advanceTime(149);
    assert.equal(target.style.getPropertyValue('visibility'), 'hidden');
    clock.advanceTime(1);
    assert.equal(await exit, false);
    assert.equal(target.style.getPropertyValue('visibility'), '');
    assertPaintCleanup(fullscreenDocument, clock);
    clock.paintFrame();
    assert.equal(target.style.getPropertyValue('visibility'), '');
});

test('backgrounding Safari restores the canvas immediately and cancels queued work', async () => {
    const { target, fullscreenDocument, clock } = createSafariPaintFixture();
    await toggleCanvasFullscreen(target, fullscreenDocument);
    const exit = toggleCanvasFullscreen(target, fullscreenDocument);
    clock.paintFrame();

    fullscreenDocument.visibilityState = 'hidden';
    fullscreenDocument.dispatchEvent('visibilitychange');
    assert.equal(target.style.getPropertyValue('visibility'), '');
    assert.equal(await exit, false);
    assertPaintCleanup(fullscreenDocument, clock);
});

test('Safari re-entry cancels an unfinished paint restoration without clearing the new fullscreen', async () => {
    const { target, fullscreenDocument, clock } = createSafariPaintFixture();
    await toggleCanvasFullscreen(target, fullscreenDocument);
    const exit = toggleCanvasFullscreen(target, fullscreenDocument);
    clock.paintFrame();
    assert.equal(target.style.getPropertyValue('visibility'), 'hidden');

    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), true);
    assert.equal(await exit, true);
    assert.equal(target.style.getPropertyValue('visibility'), '');
    assert.equal(isCanvasFullscreen(target, fullscreenDocument), true);
    assertPaintCleanup(fullscreenDocument, clock);
    clock.paintFrame();
    clock.advanceTime(200);
    assert.equal(isCanvasFullscreen(target, fullscreenDocument), true);
    clearCanvasFullscreenFallback(target, fullscreenDocument);
});

test('unmount cleanup cancels an unfinished Safari paint restoration without leaving inline styles', async () => {
    const { target, fullscreenDocument, clock } = createSafariPaintFixture();
    await toggleCanvasFullscreen(target, fullscreenDocument);
    const exit = toggleCanvasFullscreen(target, fullscreenDocument);
    target.isConnected = false;

    clearCanvasFullscreenFallback(target, fullscreenDocument);
    assert.equal(target.style.getPropertyValue('visibility'), '');
    assert.equal(await exit, false);
    assertPaintCleanup(fullscreenDocument, clock);
    clock.paintFrame();
    clock.advanceTime(200);
    assert.equal(target.style.getPropertyValue('visibility'), '');
});

test('Safari restoration does not overwrite a later visibility change from another owner', async () => {
    const { target, fullscreenDocument, clock } = createSafariPaintFixture();
    await toggleCanvasFullscreen(target, fullscreenDocument);
    const exit = toggleCanvasFullscreen(target, fullscreenDocument);
    target.style.setProperty('visibility', 'collapse', 'important');

    clock.paintFrame();
    clock.paintFrame();
    assert.equal(await exit, false);
    assert.equal(target.style.getPropertyValue('visibility'), 'collapse');
    assert.equal(target.style.getPropertyPriority('visibility'), 'important');
    assertPaintCleanup(fullscreenDocument, clock);
});

test('native fullscreen bypasses the Safari fallback paint restoration', async () => {
    const { target, fullscreenDocument, clock } = createSafariPaintFixture();
    target.requestFullscreen = () => { fullscreenDocument.fullscreenElement = target; };
    fullscreenDocument.exitFullscreen = () => { fullscreenDocument.fullscreenElement = null; };

    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), true);
    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), false);
    assert.equal(target.style.getPropertyValue('visibility'), '');
    assertPaintCleanup(fullscreenDocument, clock);
});

test('fallback exit without the active Safari edge controller does not hide the canvas', async () => {
    const { target, fullscreenDocument, clock } = createSafariPaintFixture();
    fullscreenDocument.documentElement.removeAttribute('data-safari-edges');

    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), true);
    assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), false);
    assert.equal(target.style.getPropertyValue('visibility'), '');
    assertPaintCleanup(fullscreenDocument, clock);
});

test('hidden pages and detached targets bypass the Safari paint restoration', async () => {
    for (const interruption of ['hidden', 'detached']) {
        const { target, fullscreenDocument, clock } = createSafariPaintFixture();
        await toggleCanvasFullscreen(target, fullscreenDocument);
        if (interruption === 'hidden') fullscreenDocument.visibilityState = 'hidden';
        else target.isConnected = false;

        assert.equal(await toggleCanvasFullscreen(target, fullscreenDocument), false);
        assert.equal(target.style.getPropertyValue('visibility'), '');
        assertPaintCleanup(fullscreenDocument, clock);
    }
});

test('Safari fallback replacement and direct cleanup never start a hidden paint', async () => {
    const replacement = createElement();
    const { target, fullscreenDocument, clock } = createSafariPaintFixture([replacement]);
    await toggleCanvasFullscreen(target, fullscreenDocument);
    await toggleCanvasFullscreen(replacement, fullscreenDocument);

    assert.equal(target.getAttribute(CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE), null);
    assert.equal(target.style.getPropertyValue('visibility'), '');
    assert.equal(replacement.style.getPropertyValue('visibility'), '');
    assert.equal(isCanvasFullscreen(replacement, fullscreenDocument), true);
    assertPaintCleanup(fullscreenDocument, clock);
    clearCanvasFullscreenFallback(replacement, fullscreenDocument);
    assertPaintCleanup(fullscreenDocument, clock);
});
