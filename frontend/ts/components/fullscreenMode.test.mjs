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

    return {
        children: [],
        getAttribute: (name) => attributes.get(name) ?? null,
        hasAttribute: (name) => attributes.has(name),
        isConnected: true,
        parentElement: null,
        removeAttribute: (name) => attributes.delete(name),
        setAttribute: (name, value) => attributes.set(name, value),
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
        documentElement: { classList: createClassList() },
        exitFullscreen: undefined,
        fullscreenElement: null,
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
