import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../testSupport/createViteTestServer.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const server = await createViteTestServer({
    root, configFile: `${root}/vite.config.ts`, logLevel: 'silent',
    appType: 'custom', server: { middlewareMode: true }, ssr: { noExternal: ['tone'] },
    plugins: [{
        name: 'note-selector-synth-fixture', enforce: 'pre',
        resolveId(source) { if (source === 'tone') return '\0note-selector-tone'; },
        load(id) {
            if (id !== '\0note-selector-tone') return;
            return `export const synths = [];
                export class MembraneSynth {
                    notes = []; sampleTime = 1 / 48000; disposed = false;
                    constructor(options) { this.options = options; synths.push(this); }
                    toDestination() { return this; }
                    now() { return 10; }
                    triggerAttackRelease(note) { this.notes.push(note); }
                    dispose() { this.disposed = true; }
                }`;
        },
    }],
});
after(() => server.close());
const { GameplayNoteSelector } = await server.ssrLoadModule('/ts/games/helpers/GameplayNoteSelector.ts');
const { keys } = await server.ssrLoadModule('/ts/utils/keys.ts');
const { synths } = await server.ssrLoadModule('tone');

function fixture(t, context) {
    const selector = new GameplayNoteSelector(context);
    const synth = synths.at(-1);
    t.after(() => selector.dispose());
    return { selector, synth };
}

test('first pickups preserve the current tonic in every defined key', t => {
    const notes = Object.keys(keys).map(key => {
        const { selector, synth } = fixture(t);
        selector.playNote({ key, scaleName: 'Major' });
        return [key, synth.notes[0]];
    });
    // Characterize the existing octave wrapping, including the notes above F#/Gb.
    assert.deepEqual(notes, [
        ['C', 261.63], ['C#/Db', 277.18], ['D', 293.66], ['D#/Eb', 311.13],
        ['E', 329.63], ['F', 349.23], ['F#/Gb', 370], ['G', 415.3],
        ['G#/Ab', 440], ['A', 466.16], ['A#/Bb', 493.88], ['B', 523.25],
    ]);
});

test('key and scale switches preserve repeat-pickup notes and random consumption', t => {
    const { selector, synth } = fixture(t);
    const draws = [.9, .25, .1, .75, .6, .99, .2, .4];
    let draw = 0;
    t.mock.method(Math, 'random', () => draws[draw++ % draws.length]);
    for (const [key, scaleName] of [
        ['C', 'Major'], ['G', 'Major'], ['D', 'Minor'], ['C', 'Major'],
        ['C', 'Chromatic'], ['G', 'Blues'], ['D', 'Locrian'], ['C', 'Tritone'],
    ]) {
        selector.playNote({ key, scaleName });
        selector.playNote({ key, scaleName });
    }
    assert.deepEqual(synth.notes, [
        261.63, 493.88, 293.66, 329.63, 349.23, 466.16, 293.66, 440,
        277.18, 523.25, 466.16, 415.3, undefined, 293.66, 261.63, 415.3,
    ]);
    assert.equal(draw, 33);
});

test('omitted selection reads the DOM and missing elements default to C Major', t => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
    const selected = { '[data-selected-scale]': 'Minor', '[data-selected-key]': 'D' };
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
        querySelector: selector => selected[selector] ? { textContent: selected[selector] } : null,
    } });
    const dom = fixture(t);
    dom.selector.playNote();
    assert.deepEqual(dom.synth.notes, [293.66]);
    for (const key of Object.keys(selected)) delete selected[key];
    const defaults = fixture(t);
    defaults.selector.playNote();
    assert.deepEqual(defaults.synth.notes, [261.63]);
});

test('selectors keep note history and disposal separate and pass the audio context', t => {
    t.mock.method(Math, 'random', () => .9);
    const context = {};
    const first = fixture(t, context);
    const second = fixture(t);
    first.selector.playNote({ key: 'D', scaleName: 'Minor' });
    first.selector.playNote({ key: 'D', scaleName: 'Minor' });
    first.selector.dispose();
    second.selector.playNote({ key: 'C', scaleName: 'Major' });
    assert.equal(first.synth.options.context, context);
    assert.equal(first.synth.disposed, true);
    assert.equal(second.synth.disposed, false);
    assert.deepEqual(second.synth.notes, [261.63]);
    assert.equal(first.synth.notes.length, 2);
});
