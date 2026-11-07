/**
 * Frequencies from C4 through C5, including both octave endpoints.
 */
const semitoneFrequencies = [
    261.63, 277.18, 293.66, 311.13, 329.63, 349.23, 370.0, 392.0, 415.3, 440.0,
    466.16, 493.88, 523.25,
];
const semitonesPerOctave = 12;

/**
 * Transposes an array of notes by a given number of half tones.
 * @param notes - The array of notes to transpose.
 * @param halfTones - The number of half tones to transpose the notes by.
 * @returns The transposed array of notes.
 */
export function transpose(notes: number[], halfTones: number): number[] {
    if (!Number.isInteger(halfTones)) {
        throw new RangeError('Transposition requires a finite integer number of half tones.');
    }

    return notes.map((note) => {
        const currentIndex = semitoneFrequencies.indexOf(note);
        if (currentIndex === -1) {
            throw new RangeError(`Unsupported note frequency: ${note}`);
        }

        const transposedIndex = currentIndex + halfTones;
        // Keep either C endpoint when in range; octave wrapping has twelve pitch classes.
        const newIndex = transposedIndex >= 0 && transposedIndex <= semitonesPerOctave
            ? transposedIndex
            : ((transposedIndex % semitonesPerOctave) + semitonesPerOctave) % semitonesPerOctave;

        return semitoneFrequencies[newIndex];
    });
}
