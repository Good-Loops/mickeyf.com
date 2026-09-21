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
const { scales } = await server.ssrLoadModule('/ts/utils/scales.ts');
const { transpose } = await server.ssrLoadModule('/ts/utils/transpose.ts');
const { synths } = await server.ssrLoadModule('tone');

function fixture(t, context) {
    const selector = new GameplayNoteSelector(context);
    const synth = synths.at(-1);
    t.after(() => selector.dispose());
    return { selector, synth };
}

test('first pickups play the correct tonic in every defined key', t => {
    const notes = Object.keys(keys).map(key => {
        const { selector, synth } = fixture(t);
        selector.playNote({ key, scaleName: 'Major' });
        return [key, synth.notes[0]];
    });
    assert.deepEqual(notes, Object.entries(keys).map(([key, { frequency }]) => [key, frequency]));
});

test('the previously failing key and scale switches never skip or emit an undefined pickup', t => {
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
    assert.equal(synth.notes.length, 16);
    assert.ok(synth.notes.every(note => Number.isFinite(note) && note > 0));
});

test('every offered key and scale keeps pickups in scale, including empty preferred pools', t => {
    const { selector, synth } = fixture(t);
    const draws = [0, .25, .5, .75, .999999];
    let draw = 0;
    t.mock.method(Math, 'random', () => draws[draw++ % draws.length]);
    for (const [key, { semitone }] of Object.entries(keys)) {
        const offset = semitone - keys.C.semitone;
        const shift = offset > 6 ? offset - 12 : offset;
        for (const [scaleName, { notes }] of Object.entries(scales)) {
            const expected = key === 'C' ? notes : transpose(notes, shift);
            const before = synth.notes.length;
            for (let pickup = 0; pickup < 10; pickup++) selector.playNote({ key, scaleName });
            assert.equal(synth.notes.length, before + 10, `${key} ${scaleName} skipped a pickup`);
            assert.ok(synth.notes.slice(before).every(note => Number.isFinite(note) && expected.includes(note)),
                `${key} ${scaleName} produced a missing or out-of-scale note`);
        }
    }
});

test('unknown scale names use Major for both notes and selection rules', t => {
    t.mock.method(Math, 'random', () => .9);
    const { selector, synth } = fixture(t);
    for (let pickup = 0; pickup < 4; pickup++) selector.playNote({ key: 'C', scaleName: 'unknown' });
    assert.equal(synth.notes.length, 4);
    assert.ok(synth.notes.every(note => Number.isFinite(note) && scales.Major.notes.includes(note)));
});

test('interval filtering compares semitones rather than differences in Hz', t => {
    t.mock.method(Math, 'random', () => .1);
    const { selector, synth } = fixture(t);
    selector.playNote({ key: 'C', scaleName: 'Major' });
    selector.playNote({ key: 'C', scaleName: 'Major' });
    assert.deepEqual(synth.notes, [261.63, 293.66]); // C to D is two semitones.
});

test('an empty interval pool restarts on the selected tonic without random selection', t => {
    const random = t.mock.method(Math, 'random', () => .9);
    const { selector, synth } = fixture(t);
    selector.playNote({ key: 'C#/Db', scaleName: 'Major' });
    selector.playNote({ key: 'C', scaleName: 'Pentatonic' });
    assert.deepEqual(synth.notes, [277.18, 261.63]);
    assert.equal(random.mock.callCount(), 0);
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
