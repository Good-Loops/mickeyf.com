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
                    const connectError = this.plan.connectError;
                    const source = {
                        disconnectCount: 0,
                        connect() { if (connectError) throw connectError; },
                        disconnect() { this.disconnectCount++; },
                    };
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

test('resume rejection releases failed resources and is ignored only for a cancelled upload', async () => {
    for (const cancelled of [false, true]) {
        const resume = deferred();
        await withAudio([{ resume }], async ({ engine, contexts, audios, revoked, frames }) => {
            const pending = engine.processAudio(track('resume-failed'));
            await flush();
            if (cancelled) await engine.dispose();
            const failure = new Error('resume failed');
            const settled = cancelled ? pending : assert.rejects(pending, failure);
            resume.reject(failure);
            await settled;
            assert.equal(engine.state.hasAudio, false);
            assert.equal(engine.state.playing, false);
            assert.equal(contexts[0].closeCount, 1);
            assert.equal(audios[0].endedListeners.size, 0);
            assert.equal(audios[0].paused, true);
            assert.deepEqual(revoked, ['blob:track-1']);
            assert.equal(frames.size, 0);
        });
    }
});

test('a graph connection failure releases the partial track and resets the previous analysis', async () => {
    const failure = new Error('source connection failed');
    await withAudio([{}, { connectError: failure }], async ({ engine, contexts, audios, revoked, frames }) => {
        await engine.processAudio(track('previous'));
        assert.equal(engine.state.durationSec, 60);
        await assert.rejects(engine.processAudio(track('failed')), error => error === failure);
        assert.equal(contexts[1].closeCount, 1);
        assert.equal(contexts[1].sources[0].disconnectCount, 1);
        assert.equal(audios[1].endedListeners.size, 0);
        assert.equal(audios[1].paused, true);
        assert.deepEqual(revoked, ['blob:track-1', 'blob:track-2']);
        assert.equal(engine.state.hasAudio, false);
        assert.equal(engine.state.playing, false);
        assert.equal(engine.state.durationSec, 0);
        assert.equal(frames.size, 0);
    });
});

test('a newer upload survives failed-track cleanup and suppresses the obsolete failure', async () => {
    const resume = deferred();
    const close = deferred();
    await withAudio([{ resume, close }], async ({ engine, contexts, audios, revoked, frames }) => {
        const previous = engine.processAudio(track('failed'));
        const outcome = previous.then(() => undefined, error => error);
        await flush();
        resume.reject(new Error('old resume failed'));
        await flush();
        assert.equal(contexts[0].closeCount, 1, 'failure starts cleanup before another upload');
        await engine.processAudio(track('current'));
        close.resolve();
        assert.equal(await outcome, undefined);
        assert.equal(contexts[1].closeCount, 0);
        assert.equal(audios[1].endedListeners.size, 1);
        assert.equal(audios[1].paused, false);
        assert.deepEqual(revoked, ['blob:track-1']);
        assert.equal(engine.state.hasAudio, true);
        assert.equal(engine.state.playing, true);
        assert.equal(engine.state.durationSec, 60);
        assert.equal(frames.size, 1);
    });
});

for (const control of ['pause', 'stop']) {
    for (const waitingFor of ['resume', 'play']) {
        test(`${control} wins over explicit Play waiting for ${waitingFor}`, async () => {
            const plan = {};
            const gate = deferred();
            await withAudio([plan], async ({ engine, contexts, audios, frames }) => {
                await engine.processAudio(track('transport'));
                engine.pause();
                audios[0].currentTime = 12;
                plan[waitingFor] = gate;
                if (waitingFor === 'resume') contexts[0].state = 'suspended';
                const pending = engine.play();
                await flush();
                engine[control]();
                gate.resolve();
                await pending;
                assert.equal(audios[0].playCount, waitingFor === 'resume' ? 1 : 2);
                assert.equal(audios[0].paused, true);
                assert.equal(audios[0].currentTime, control === 'stop' ? 0 : 12);
                assert.equal(engine.state.playing, false);
                assert.equal(frames.size, 0);
                await engine.play();
                assert.equal(engine.state.playing, true, 'a fresh Play still works');
                assert.equal(frames.size, 1);
            });
        });

        test(`${control} suppresses upload autoplay while ${waitingFor} is pending`, async () => {
            const gate = deferred();
            await withAudio([{ [waitingFor]: gate }], async ({ engine, audios, frames }) => {
                const pending = engine.processAudio(track('upload'));
                await flush();
                engine[control]();
                gate.resolve();
                await pending;
                assert.equal(engine.state.hasAudio, true, 'the track remains loaded');
                assert.equal(engine.state.playing, false);
                assert.equal(audios[0].paused, true);
                assert.equal(audios[0].playCount, waitingFor === 'resume' ? 0 : 1);
                assert.equal(frames.size, 0);
                await engine.play();
                assert.equal(engine.state.playing, true);
            });
        });
    }
}

test('Stop before upload allocation suppresses autoplay without cancelling loading', async () => {
    await withAudio([], async ({ engine, audios }) => {
        const pending = engine.processAudio(track('not-yet-allocated'));
        engine.stop();
        await pending;
        assert.equal(engine.state.hasAudio, true);
        assert.equal(engine.state.playing, false);
        assert.equal(audios[0].playCount, 0);
    });
});

for (const control of ['pause', 'stop', 'ended']) {
    test(`${control} cancels automatic recovery waiting for context resume`, async () => {
        const plan = {};
        const resume = deferred();
        await withAudio([plan], async ({ engine, contexts, audios, frames }) => {
            await engine.processAudio(track('interrupted'));
            plan.resume = resume;
            contexts[0].state = 'suspended';
            audios[0].paused = true;
            const [id, frame] = frames.entries().next().value;
            frames.delete(id);
            frame();
            if (control === 'ended') {
                audios[0].ended = true;
                audios[0].dispatchEvent(new Event('ended'));
            } else engine[control]();
            resume.resolve();
            await flush();
            assert.equal(audios[0].playCount, 1);
            assert.equal(engine.state.playing, false);
            assert.equal(frames.size, 0);
        });
    });
}

for (const outcome of ['resolve', 'reject']) {
    test(`an older Play ${outcome} cannot override a newer Play on the same track`, async () => {
        const plan = {};
        const play = deferred();
        await withAudio([plan], async ({ engine, audios, frames }) => {
            await engine.processAudio(track('same-track'));
            engine.pause();
            plan.play = play;
            const previous = engine.play();
            await flush();
            engine.pause();
            delete plan.play;
            await engine.play();
            play[outcome](new Error('old Play failed'));
            await previous;
            assert.equal(audios[0].paused, false);
            assert.equal(engine.state.playing, true);
            assert.equal(frames.size, 1);
        });
    });
}

for (const change of ['dispose', 'replace']) {
    test(`${change} prevents an old explicit Play from resuming its detached track`, async () => {
        const plan = {};
        const resume = deferred();
        await withAudio([plan], async ({ engine, contexts, audios, frames }) => {
            await engine.processAudio(track('old'));
            engine.pause();
            contexts[0].state = 'suspended';
            plan.resume = resume;
            const previous = engine.play();
            await flush();
            if (change === 'dispose') await engine.dispose();
            else await engine.processAudio(track('new'));
            resume.resolve();
            await previous;
            assert.equal(audios[0].playCount, 1);
            assert.equal(audios[0].paused, true);
            assert.equal(engine.state.playing, change === 'replace');
            assert.equal(frames.size, change === 'replace' ? 1 : 0);
        });
    });
}

test('Pause at the play-resolution boundary cannot be overwritten by a caller continuation', async () => {
    const plan = {};
    const play = deferred();
    await withAudio([plan], async ({ engine, frames }) => {
        await engine.processAudio(track('boundary'));
        engine.pause();
        plan.play = play;
        const pending = engine.play();
        await flush();
        const pausing = play.promise.then(() => engine.pause());
        play.resolve();
        await Promise.all([pending, pausing]);
        assert.equal(engine.state.playing, false);
        assert.equal(frames.size, 0);
    });
});

test('a current Play failure remains reported and stops analysis', async t => {
    const plan = {};
    const play = deferred();
    const errors = t.mock.method(console, 'error', () => {});
    await withAudio([plan], async ({ engine, frames }) => {
        await engine.processAudio(track('failure'));
        plan.play = play;
        const pending = engine.play();
        await flush();
        const failure = new Error('current Play failed');
        play.reject(failure);
        await pending;
        assert.equal(engine.state.playing, false);
        assert.equal(frames.size, 0);
        assert.equal(errors.mock.callCount(), 1);
        assert.equal(errors.mock.calls[0].arguments[1], failure);
    });
});
