import assert from 'node:assert/strict';
import test from 'node:test';
import {
    bindThreeBossesPortraitLayout,
    bindUnityVisibility,
    configureThreeBossesTouchControls,
    isThreeBossesAvailableInCurrentBrowser,
    isThreeBossesMobileBrowser,
    shouldEnableThreeBossesTouchControls,
    shouldUseThreeBossesPortraitLayout,
    THREE_BOSSES_RUN_SESSION_OBJECT,
} from './unityVisibility.ts';

const receiver = THREE_BOSSES_RUN_SESSION_OBJECT;

test('enables touch controls only for touch-capable mobile browsers', () => {
    assert.equal(shouldEnableThreeBossesTouchControls({
        maxTouchPoints: 0,
        userAgent: 'Mozilla/5.0 (Linux; Android 10)',
        userAgentDataMobile: true,
    }), false);
    assert.equal(shouldEnableThreeBossesTouchControls({
        maxTouchPoints: 10,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        userAgentDataMobile: false,
    }), false);
    assert.equal(shouldEnableThreeBossesTouchControls({
        maxTouchPoints: 0,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
        userAgentDataMobile: false,
    }), false);
    assert.equal(shouldEnableThreeBossesTouchControls({
        maxTouchPoints: 5,
        userAgent: 'Mozilla/5.0 (Linux; Android 10; K)',
    }), true);
    assert.equal(shouldEnableThreeBossesTouchControls({
        maxTouchPoints: 5,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    }), true);
    assert.equal(shouldEnableThreeBossesTouchControls({
        maxTouchPoints: 5,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
    }), true);
    assert.equal(shouldEnableThreeBossesTouchControls({
        maxTouchPoints: 5,
        userAgent: 'Mozilla/5.0',
        userAgentDataMobile: true,
    }), true);
});

test('blocks mobile browsers without mistaking desktop touch devices for phones', () => {
    assert.equal(isThreeBossesMobileBrowser({
        maxTouchPoints: 0,
        userAgent: 'Mozilla/5.0 (Linux; Android 10)',
    }), true);
    assert.equal(isThreeBossesMobileBrowser({
        maxTouchPoints: 5,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    }), true);
    assert.equal(isThreeBossesMobileBrowser({
        maxTouchPoints: 0,
        userAgent: 'Mozilla/5.0',
        userAgentDataMobile: true,
    }), true);
    assert.equal(isThreeBossesMobileBrowser({
        maxTouchPoints: 5,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
    }), true);
    assert.equal(isThreeBossesMobileBrowser({
        maxTouchPoints: 10,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        userAgentDataMobile: false,
    }), false);
    assert.equal(isThreeBossesMobileBrowser({
        maxTouchPoints: 0,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
        userAgentDataMobile: false,
    }), false);
});

test('allows an explicit preview without changing real touch-device detection', () => {
    const android = {
        maxTouchPoints: 5,
        userAgent: 'Mozilla/5.0 (Linux; Android 15)',
        userAgentDataMobile: true,
    };

    assert.equal(isThreeBossesAvailableInCurrentBrowser(android), false);
    assert.equal(isThreeBossesAvailableInCurrentBrowser(android, true), true);
    assert.equal(shouldEnableThreeBossesTouchControls(android), true);
});

test('sends the resolved mobile-touch permission to the persistent Unity service', () => {
    const messages = [];
    const instance = {
        SendMessage: (...message) => messages.push(message),
    };

    configureThreeBossesTouchControls(instance, {
        maxTouchPoints: 10,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        userAgentDataMobile: false,
    });
    configureThreeBossesTouchControls(instance, {
        maxTouchPoints: 5,
        userAgent: 'Mozilla/5.0 (Linux; Android 10; K)',
        userAgentDataMobile: true,
    });

    assert.deepEqual(messages, [
        [receiver, 'ConfigureTouchControls', '0'],
        [receiver, 'ConfigureTouchControls', '1'],
    ]);

    assert.throws(
        () => configureThreeBossesTouchControls({}, {
            maxTouchPoints: 5,
            userAgent: 'Mozilla/5.0 (Linux; Android 10; K)',
        }),
        /missing the required touch-controls API/,
    );
});

test('uses portrait layout only for a touch-capable mobile browser in portrait', () => {
    const android = {
        maxTouchPoints: 5,
        userAgent: 'Mozilla/5.0 (Linux; Android 15)',
        userAgentDataMobile: true,
    };
    const desktop = {
        maxTouchPoints: 0,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        userAgentDataMobile: false,
    };

    assert.equal(shouldUseThreeBossesPortraitLayout(android, {
        innerWidth: 390,
        innerHeight: 844,
    }), true);
    assert.equal(shouldUseThreeBossesPortraitLayout(android, {
        innerWidth: 844,
        innerHeight: 390,
    }), false);
    assert.equal(shouldUseThreeBossesPortraitLayout(desktop, {
        innerWidth: 390,
        innerHeight: 844,
    }), false);
});

class FakeResponsiveWindow {
    constructor(innerWidth, innerHeight) {
        this.innerWidth = innerWidth;
        this.innerHeight = innerHeight;
        this.listeners = {
            resize: new Set(),
            orientationchange: new Set(),
        };
    }

    addEventListener(type, listener) {
        this.listeners[type].add(listener);
    }

    removeEventListener(type, listener) {
        this.listeners[type].delete(listener);
    }

    resizeTo(innerWidth, innerHeight, eventType = 'resize') {
        this.innerWidth = innerWidth;
        this.innerHeight = innerHeight;
        for (const listener of this.listeners[eventType]) listener(new Event(eventType));
    }
}

test('synchronizes portrait layout on rotation and releases both listeners', () => {
    const messages = [];
    const instance = {
        SendMessage: (...message) => messages.push(message),
    };
    const android = {
        maxTouchPoints: 5,
        userAgent: 'Mozilla/5.0 (Linux; Android 15)',
        userAgentDataMobile: true,
    };
    const viewport = new FakeResponsiveWindow(390, 844);

    const release = bindThreeBossesPortraitLayout(instance, android, viewport);
    viewport.resizeTo(400, 820);
    viewport.resizeTo(844, 390, 'orientationchange');
    viewport.resizeTo(390, 844);
    release();
    release();
    viewport.resizeTo(844, 390);

    assert.deepEqual(messages, [
        [receiver, 'ConfigurePortraitUiLayout', '1'],
        [receiver, 'ConfigurePortraitUiLayout', '0'],
        [receiver, 'ConfigurePortraitUiLayout', '1'],
    ]);
    assert.equal(viewport.listeners.resize.size, 0);
    assert.equal(viewport.listeners.orientationchange.size, 0);

    assert.throws(
        () => bindThreeBossesPortraitLayout({}, android, viewport),
        /missing the required portrait-layout API/,
    );
});

class FakeVisibilityDocument {
    constructor(hidden = false, focused = true) {
        this.hidden = hidden;
        this.focused = focused;
        this.listeners = new Set();
    }

    hasFocus() {
        return this.focused;
    }

    addEventListener(type, listener) {
        assert.equal(type, 'visibilitychange');
        this.listeners.add(listener);
    }

    removeEventListener(type, listener) {
        assert.equal(type, 'visibilitychange');
        this.listeners.delete(listener);
    }

    setHidden(hidden) {
        this.hidden = hidden;
        for (const listener of this.listeners) listener(new Event('visibilitychange'));
    }
}

class FakeVisibilityWindow {
    constructor() {
        this.listeners = {
            blur: new Set(),
            focus: new Set(),
        };
    }

    addEventListener(type, listener) {
        this.listeners[type].add(listener);
    }

    removeEventListener(type, listener) {
        this.listeners[type].delete(listener);
    }

    dispatch(type) {
        for (const listener of this.listeners[type]) listener(new Event(type));
    }
}

const createInstance = () => {
    const messages = [];
    const mainLoop = [];

    return {
        instance: {
            Module: {
                pauseMainLoop: () => mainLoop.push('pause'),
                resumeMainLoop: () => mainLoop.push('resume'),
            },
            SendMessage: (...message) => messages.push(message),
        },
        mainLoop,
        messages,
    };
};

const bind = (instance, visibilityDocument) => {
    const visibilityWindow = new FakeVisibilityWindow();
    return {
        cleanup: bindUnityVisibility(instance, visibilityDocument, visibilityWindow),
        visibilityWindow,
    };
};

test('binds the current visible state and ignores duplicate visibility events', () => {
    const visibilityDocument = new FakeVisibilityDocument();
    const { instance, mainLoop, messages } = createInstance();
    const { cleanup } = bind(instance, visibilityDocument);

    assert.deepEqual(messages, []);
    assert.deepEqual(mainLoop, []);

    visibilityDocument.setHidden(false);
    assert.equal(messages.length, 0);

    cleanup();
});

test('orders receiver and main-loop calls across hidden and visible states', () => {
    const visibilityDocument = new FakeVisibilityDocument();
    const { instance, mainLoop, messages } = createInstance();
    const { cleanup } = bind(instance, visibilityDocument);

    visibilityDocument.setHidden(true);
    visibilityDocument.setHidden(true);
    visibilityDocument.setHidden(false);

    assert.deepEqual(messages, [
        [receiver, 'PauseForDocumentHidden'],
        [receiver, 'ResumeFromDocumentHidden'],
    ]);
    assert.deepEqual(mainLoop, ['pause', 'resume']);

    cleanup();
});

test('cleanup resumes an initially hidden player and removes the listener once', () => {
    const visibilityDocument = new FakeVisibilityDocument(true);
    const { instance, mainLoop, messages } = createInstance();
    const { cleanup } = bind(instance, visibilityDocument);

    cleanup();
    cleanup();
    visibilityDocument.setHidden(false);

    assert.deepEqual(messages, [
        [receiver, 'PauseForDocumentHidden'],
        [receiver, 'ResumeFromDocumentHidden'],
    ]);
    assert.deepEqual(mainLoop, ['pause', 'resume']);
});

test('fails before binding when the Unity main-loop API is unavailable', () => {
    const visibilityDocument = new FakeVisibilityDocument();

    assert.throws(
        () => bindUnityVisibility(
            { SendMessage: () => {} },
            visibilityDocument,
            new FakeVisibilityWindow(),
        ),
        /missing the required background-pause API/,
    );
});

test('retries a receiver resume without pausing the resumed main loop again', () => {
    const visibilityDocument = new FakeVisibilityDocument();
    const { instance, mainLoop, messages } = createInstance();
    let shouldFailResume = true;
    const originalSendMessage = instance.SendMessage;
    instance.SendMessage = (...message) => {
        originalSendMessage(...message);
        if (message[1] === 'ResumeFromDocumentHidden' && shouldFailResume) {
            shouldFailResume = false;
            throw new Error('receiver resume failed');
        }
    };
    const { cleanup } = bind(instance, visibilityDocument);

    visibilityDocument.setHidden(true);
    assert.throws(
        () => visibilityDocument.setHidden(false),
        /receiver resume failed/,
    );
    assert.deepEqual(mainLoop, ['pause', 'resume']);

    visibilityDocument.setHidden(false);
    assert.deepEqual(messages, [
        [receiver, 'PauseForDocumentHidden'],
        [receiver, 'ResumeFromDocumentHidden'],
        [receiver, 'ResumeFromDocumentHidden'],
    ]);
    assert.deepEqual(mainLoop, ['pause', 'resume']);

    cleanup();
});

test('rolls back the receiver when pausing the main loop fails', () => {
    const visibilityDocument = new FakeVisibilityDocument();
    const { instance, messages } = createInstance();
    instance.Module.pauseMainLoop = () => {
        throw new Error('main loop pause failed');
    };
    bind(instance, visibilityDocument);

    assert.throws(
        () => visibilityDocument.setHidden(true),
        /main loop pause failed/,
    );
    assert.deepEqual(messages, [
        [receiver, 'PauseForDocumentHidden'],
        [receiver, 'ResumeFromDocumentHidden'],
    ]);
});

test('cleanup still resumes the main loop when receiver cleanup fails', () => {
    const visibilityDocument = new FakeVisibilityDocument(true);
    const { instance, mainLoop, messages } = createInstance();
    const originalSendMessage = instance.SendMessage;
    instance.SendMessage = (...message) => {
        originalSendMessage(...message);
        if (message[1] === 'ResumeFromDocumentHidden')
            throw new Error('receiver cleanup failed');
    };
    const { cleanup } = bind(instance, visibilityDocument);

    assert.doesNotThrow(cleanup);
    visibilityDocument.setHidden(false);

    assert.deepEqual(messages, [
        [receiver, 'PauseForDocumentHidden'],
        [receiver, 'ResumeFromDocumentHidden'],
    ]);
    assert.deepEqual(mainLoop, ['pause', 'resume']);
});

test('window blur and focus pause and resume when Page Visibility stays visible', () => {
    const visibilityDocument = new FakeVisibilityDocument();
    const { instance, mainLoop, messages } = createInstance();
    const { cleanup, visibilityWindow } = bind(instance, visibilityDocument);

    visibilityWindow.dispatch('blur');
    visibilityWindow.dispatch('blur');
    visibilityWindow.dispatch('focus');

    assert.deepEqual(messages, [
        [receiver, 'PauseForDocumentHidden'],
        [receiver, 'ResumeFromDocumentHidden'],
    ]);
    assert.deepEqual(mainLoop, ['pause', 'resume']);

    cleanup();
});

test('binds an initially unfocused visible document as paused', () => {
    const visibilityDocument = new FakeVisibilityDocument(false, false);
    const { instance, mainLoop, messages } = createInstance();
    const { cleanup, visibilityWindow } = bind(instance, visibilityDocument);

    assert.deepEqual(messages, [
        [receiver, 'PauseForDocumentHidden'],
    ]);
    assert.deepEqual(mainLoop, ['pause']);

    visibilityDocument.focused = true;
    visibilityWindow.dispatch('focus');

    assert.deepEqual(messages, [
        [receiver, 'PauseForDocumentHidden'],
        [receiver, 'ResumeFromDocumentHidden'],
    ]);
    assert.deepEqual(mainLoop, ['pause', 'resume']);

    cleanup();
});
