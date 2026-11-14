import assert from 'node:assert/strict';
import test from 'node:test';
import { transpose } from './transpose.ts';

test('negative tonic offsets produce G through B without an extra pitch class', () => {
    for (const [halfTones, expected] of [
        [-5, 392], [-4, 415.3], [-3, 440], [-2, 466.16], [-1, 493.88],
    ]) {
        assert.deepEqual(transpose([261.63], halfTones), [expected]);
    }
});

test('in-range transposition preserves both C endpoints', () => {
    assert.deepEqual(transpose([493.88], 1), [523.25]);
    assert.deepEqual(transpose([261.63], 12), [523.25]);
    assert.deepEqual(transpose([523.25], -12), [261.63]);
    assert.deepEqual(transpose([261.63, 523.25], 0), [261.63, 523.25]);
});

test('out-of-range shifts wrap by twelve semitones in both directions', () => {
    for (const [note, halfTones, expected] of [
        [261.63, -12, 261.63], [261.63, -13, 493.88],
        [261.63, 24, 261.63], [261.63, 25, 277.18],
        [261.63, -1201, 493.88], [261.63, 1201, 277.18],
        [523.25, 1, 277.18], [523.25, 12, 261.63],
    ]) {
        assert.deepEqual(transpose([note], halfTones), [expected]);
    }
});

test('transposition rejects fractional and nonfinite shifts', () => {
    for (const halfTones of [0.5, -0.5, NaN, Infinity, -Infinity]) {
        assert.throws(() => transpose([261.63], halfTones), RangeError);
        assert.throws(() => transpose([], halfTones), RangeError);
    }
});

test('transposition rejects notes absent from the frequency table', () => {
    for (const note of [0, 391.99, 261.625, NaN, Infinity, -Infinity]) {
        assert.throws(() => transpose([note], 0), /Unsupported note frequency/);
    }
});
