import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioEngine } from './AudioEngine.ts';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const track = name => new File([], `${name}.mp3`, { type: 'audio/mpeg' });

async function withAudio(plans, check) {
    const contexts = [];
    const audios = [];
    const revoked = [];
    const frames = new Map();
    let nextFrame = 0;
    let nextUrl = 0;
    const values = {
        window: {
            AudioContext: class {
                constructor() {
                    this.plan = plans[contexts.length] ?? {};
                    this.sampleRate = 48_000;
                    this.destination = {};
                    this.state = 'running';
                    this.closeCount = 0;
                    this.sources = [];
                    contexts.push(this);
                }
                resume() { return this.plan.resume?.promise ?? Promise.resolve(); }
                close() {
                    this.state = 'closed';
                    this.closeCount++;
                    return this.closeCount === 1 ? this.plan.close?.promise ?? Promise.resolve() : Promise.resolve();
                }
                createAnalyser() {
                    return { fftSize: 0, connect() {}, getFloatTimeDomainData(input) { input.fill(0); } };
                }
                createMediaElementSource() {
                    const source = { disconnectCount: 0, connect() {}, disconnect() { this.disconnectCount++; } };
                    this.sources.push(source);
                    return source;
                }
            },
        },
        Audio: class extends EventTarget {
            constructor(url) {
                super();
                this.plan = plans[audios.length] ?? {};
                this.src = url;
                this.currentTime = 0;
                this.duration = 60;
                this.ended = false;
                this.paused = true;
                this.playCount = 0;
                this.endedListeners = new Set();
                audios.push(this);
            }
            addEventListener(type, listener) {
                super.addEventListener(type, listener);
                if (type === 'ended') this.endedListeners.add(listener);
            }
            removeEventListener(type, listener) {
                super.removeEventListener(type, listener);
                if (type === 'ended') this.endedListeners.delete(listener);
            }
            load() {}
            play() { this.playCount++; this.paused = false; return this.plan.play?.promise ?? Promise.resolve(); }
            pause() { this.paused = true; }
        },
        URL: { createObjectURL: () => `blob:track-${++nextUrl}`, revokeObjectURL: url => revoked.push(url) },
        requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
        cancelAnimationFrame: id => frames.delete(id),
    };
    const originals = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const engine = new AudioEngine();
    try {
        for (const [key, value] of Object.entries(values)) {
            Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        }
        await check({ engine, contexts, audios, revoked, frames });
    } finally {
        for (const plan of plans) {
            plan.resume?.resolve(); plan.play?.resolve(); plan.close?.resolve();
        }
        await flush();
        await engine.dispose();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
}

test('normal loading starts playback and disposal releases the owned resources once', async () => {
    await withAudio([], async ({ engine, contexts, audios, revoked, frames }) => {
        await engine.processAudio(track('normal'));
        assert.equal(engine.state.hasAudio, true);
        assert.equal(engine.state.playing, true);
        assert.equal(audios[0].playCount, 1);
        assert.equal(frames.size, 1);
        await engine.dispose();
        await engine.dispose();
        assert.equal(engine.state.hasAudio, false);
        assert.equal(engine.state.playing, false);
        assert.equal(contexts[0].closeCount, 1);
        assert.equal(contexts[0].sources[0].disconnectCount, 1);
        assert.equal(audios[0].endedListeners.size, 0);
        assert.equal(audios[0].paused, true);
        assert.deepEqual(revoked, ['blob:track-1']);
        assert.equal(frames.size, 0);
    });
});

test('disposing before initial teardown completes prevents allocation by the cancelled upload', async () => {
    await withAudio([], async ({ engine, contexts, audios, frames }) => {
        const pending = engine.processAudio(track('cancelled'));
        await engine.dispose();
        await pending;
        assert.equal(contexts.length, 0);
        assert.equal(audios.length, 0);
        assert.equal(engine.state.hasAudio, false);
        assert.equal(frames.size, 0);
    });
});

test('disposing during context resume prevents late playback and releases partially initialized audio', async () => {
    const resume = deferred();
    await withAudio([{ resume }], async ({ engine, contexts, audios, revoked, frames }) => {
        const pending = engine.processAudio(track('cancelled'));
        await flush();
        await engine.dispose();
        resume.resolve();
        await pending;
        assert.equal(audios[0].playCount, 0);
        assert.equal(audios[0].endedListeners.size, 0);
        assert.equal(contexts[0].closeCount, 1);
        assert.equal(contexts[0].sources.length, 0);
        assert.deepEqual(revoked, ['blob:track-1']);
        assert.equal(engine.state.hasAudio, false);
        assert.equal(engine.state.playing, false);
        assert.equal(frames.size, 0);
    });
});

test('a replaced upload cannot overwrite the newer playing track after its resume resolves', async () => {
    const resume = deferred();
    await withAudio([{ resume }], async ({ engine, contexts, audios, revoked, frames }) => {
        const previous = engine.processAudio(track('previous'));
        await flush();
        await engine.processAudio(track('current'));
        resume.resolve();
        await previous;
        assert.equal(audios[0].playCount, 0);
        assert.equal(audios[1].playCount, 1);
        assert.equal(contexts[0].closeCount, 1);
        assert.equal(contexts[1].closeCount, 0);
        assert.deepEqual(revoked, ['blob:track-1']);
        assert.equal(engine.state.playing, true);
        assert.equal(frames.size, 1);
        await engine.dispose();
        assert.equal(contexts[1].closeCount, 1);
        assert.equal(audios[1].endedListeners.size, 0);
        assert.deepEqual(revoked, ['blob:track-1', 'blob:track-2']);
    });
});

test('an old disposal finishing context close cannot clear a newer track or reset its state', async () => {
    const close = deferred();
    await withAudio([{ close }], async ({ engine, contexts, audios, revoked, frames }) => {
        await engine.processAudio(track('previous'));
        const disposing = engine.dispose();
        await engine.processAudio(track('current'));
        close.resolve();
        await disposing;
        assert.equal(engine.state.hasAudio, true);
        assert.equal(engine.state.playing, true);
        assert.equal(contexts[0].closeCount, 1);
        assert.deepEqual(revoked, ['blob:track-1']);
        assert.equal(frames.size, 1);
        await engine.dispose();
        assert.equal(contexts[1].closeCount, 1);
        assert.equal(audios[1].endedListeners.size, 0);
        assert.deepEqual(revoked, ['blob:track-1', 'blob:track-2']);
    });
});

test('an upload waiting for the old context to close remains cancelled after disposal', async () => {
    const close = deferred();
    await withAudio([{ close }], async ({ engine, contexts, frames }) => {
        await engine.processAudio(track('previous'));
        const replacing = engine.processAudio(track('cancelled'));
        await engine.dispose();
        close.resolve();
        await replacing;
        assert.equal(contexts.length, 1);
        assert.equal(contexts[0].closeCount, 1);
        assert.equal(engine.state.hasAudio, false);
        assert.equal(engine.state.playing, false);
        assert.equal(frames.size, 0);
    });
});

test('a late initial play promise cannot mark a disposed track as playing again', async () => {
    const play = deferred();
    await withAudio([{ play }], async ({ engine, contexts, audios, frames }) => {
        const pending = engine.processAudio(track('cancelled'));
        await flush();
        await engine.dispose();
        play.resolve();
        await pending;
        assert.equal(engine.state.hasAudio, false);
        assert.equal(engine.state.playing, false);
        assert.equal(audios[0].paused, true);
        assert.equal(contexts[0].closeCount, 1);
        assert.equal(frames.size, 0);
    });
});

test('resume rejection is ignored only when that upload has already been cancelled', async () => {
    for (const cancelled of [false, true]) {
        const resume = deferred();
        await withAudio([{ resume }], async ({ engine, contexts }) => {
            const pending = engine.processAudio(track('resume-failed'));
            await flush();
            if (cancelled) await engine.dispose();
            const failure = new Error('resume failed');
            const settled = cancelled ? pending : assert.rejects(pending, failure);
            resume.reject(failure);
            await settled;
            assert.equal(engine.state.playing, false);
            assert.equal(contexts[0].closeCount, cancelled ? 1 : 0);
        });
    }
});
