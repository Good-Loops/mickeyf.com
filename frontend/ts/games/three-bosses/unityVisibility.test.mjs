import assert from 'node:assert/strict';
import test from 'node:test';
import { bindUnityVisibility } from './unityVisibility.ts';

const receiver = 'Three Bosses Run Session';

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
