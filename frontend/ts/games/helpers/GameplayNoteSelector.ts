import { scales } from '@/utils/scales';
import { keys } from '@/utils/keys';
import { transpose } from '@/utils/transpose';
import { createGameplayNotePlayback } from './gameplayNotePlayback';

import { MembraneSynth, type Context } from 'tone';

const BASE_SCALE_KEY = 'C';

const VALID_INTERVALS_BY_SCALE: Readonly<Record<string, readonly number[]>> = {
    Major: [2, 4, 5, 7, 9, 11],
    Minor: [2, 3, 5, 7, 8, 10],
    Pentatonic: [2, 4, 7, 9],
    Blues: [3, 5, 6, 7, 10], // Blues scale adds the 'blue note' (flat 5)
    Dorian: [2, 3, 5, 7, 9, 10],
    Mixolydian: [2, 4, 5, 7, 9, 10],
    Phrygian: [1, 3, 5, 7, 8, 10],
    Lydian: [2, 4, 6, 7, 9, 11],
    Locrian: [1, 3, 5, 6, 8, 10],
    Chromatic: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], // All semitones
    'Harmonic Major': [2, 4, 5, 7, 8, 11],
    'Melodic Minor': [2, 3, 5, 7, 9, 11],
    'Whole Tone': [2, 4, 6, 8, 10], // All intervals are whole steps
    'Hungarian Minor': [2, 3, 6, 7, 8, 11],
    'Double Harmonic': [1, 4, 5, 7, 8, 11], // Also known as the Byzantine scale
    'Neapolitan Major': [1, 3, 5, 7, 9, 11],
    'Neapolitan Minor': [1, 3, 5, 7, 8, 11],
    Augmented: [3, 4, 7, 8], // Alternating minor third and half step
    Hexatonic: [2, 4, 7, 9, 10], // A generic 6-note scale
    Enigmatic: [1, 4, 6, 8, 10, 11],
    'Spanish Gypsy': [1, 4, 5, 7, 8, 10], // Also called the Phrygian Dominant
    Hirajoshi: [2, 3, 7, 8], // Japanese pentatonic scale
    'Balinese Pelog': [1, 2, 6, 7, 11], // Indonesian gamelan scale
    Egyptian: [2, 5, 7, 10], // Pentatonic scale used in traditional Egyptian music
    'Hungarian Gypsy': [2, 3, 6, 7, 8, 11], // Similar to Hungarian Minor
    Persian: [1, 4, 5, 6, 8, 11], // Persian scale with half and whole steps
    Tritone: [3, 6, 9], // Contains tritone intervals
    Flamenco: [1, 3, 4, 6, 8, 9, 11], // Typical flamenco scale intervals
    Iwato: [1, 5, 6, 10], // Japanese scale
    'Blues Heptatonic': [2, 3, 5, 6, 7, 10], // Seven-note blues scale
};

const CHORD_TONE_PATTERNS: Readonly<Record<string, readonly number[]>> = {
    standardFour: [0, 2, 4, 6], // Root, third, fifth, seventh
    standardThree: [0, 2, 4], // Root, third, fifth (no seventh)
    augmented: [0, 2, 4], // Root, major third, augmented fifth
    minorBlues: [0, 3, 5], // Root, flat third, fifth
    locrian: [0, 2, 3], // Root, minor third, diminished fifth
    tritone: [0, 3, 6], // Root and tritone
    empty: [], // For scales without defined chord tones
};

const CHORD_TONE_INDICES_BY_SCALE: Readonly<Record<string, readonly number[]>> = {
    Major: CHORD_TONE_PATTERNS['standardFour'],
    Minor: CHORD_TONE_PATTERNS['standardFour'],
    Pentatonic: CHORD_TONE_PATTERNS['standardThree'],
    Blues: CHORD_TONE_PATTERNS['minorBlues'],
    Dorian: CHORD_TONE_PATTERNS['standardFour'],
    Mixolydian: CHORD_TONE_PATTERNS['standardFour'],
    Phrygian: CHORD_TONE_PATTERNS['standardThree'],
    Lydian: CHORD_TONE_PATTERNS['standardFour'],
    Locrian: CHORD_TONE_PATTERNS['locrian'],
    Chromatic: CHORD_TONE_PATTERNS['empty'],
    'Harmonic Major': CHORD_TONE_PATTERNS['standardFour'],
    'Melodic Minor': CHORD_TONE_PATTERNS['standardFour'],
    'Whole Tone': CHORD_TONE_PATTERNS['standardThree'],
    'Hungarian Minor': CHORD_TONE_PATTERNS['standardFour'],
    'Double Harmonic': CHORD_TONE_PATTERNS['standardFour'],
    'Neapolitan Major': CHORD_TONE_PATTERNS['standardFour'],
    'Neapolitan Minor': CHORD_TONE_PATTERNS['standardFour'],
    Augmented: CHORD_TONE_PATTERNS['augmented'],
    Hexatonic: CHORD_TONE_PATTERNS['standardThree'],
    Enigmatic: CHORD_TONE_PATTERNS['augmented'],
    'Spanish Gypsy': CHORD_TONE_PATTERNS['standardThree'],
    Hirajoshi: CHORD_TONE_PATTERNS['standardThree'],
    'Balinese Pelog': CHORD_TONE_PATTERNS['standardThree'],
    Egyptian: CHORD_TONE_PATTERNS['standardThree'],
    'Hungarian Gypsy': CHORD_TONE_PATTERNS['standardFour'],
    Persian: CHORD_TONE_PATTERNS['standardThree'],
    Tritone: CHORD_TONE_PATTERNS['tritone'],
    Flamenco: CHORD_TONE_PATTERNS['minorBlues'],
    Iwato: CHORD_TONE_PATTERNS['standardThree'],
    'Blues Heptatonic': CHORD_TONE_PATTERNS['standardFour'],
};

/**
 * Represents a musical scale definition.
 */
type Scale = {
    name: string;
    notes: number[];
};

/**
 * Note selection + playback helper.
 *
 * Responsibility:
 * - Select a scale/key and emit a short percussive note.
 *
 * Side effects:
 * - Plays audio via Tone.js.
 * - If no explicit selection is provided, reads from the DOM (`[data-selected-scale]`, `[data-selected-key]`).
 *
 * Units:
 * - Notes are frequencies in **Hz**.
 *
 * @category Games — Core
 */
export class GameplayNoteSelector {
    private synth: MembraneSynth;
    private playSafely: ReturnType<typeof createGameplayNotePlayback>;

    constructor(context?: Context) {
        this.synth = new MembraneSynth(context ? { context } : {}).toDestination();
        this.playSafely = createGameplayNotePlayback(this.synth, (error) => {
            console.warn('P4-Vega pickup audio could not play; gameplay will continue.', error);
        });
    }

    private lastPlayedNote?: number;

    private selectedScale: Scale = {
        name: 'Major',
        notes: scales['Major'].notes,
    };

    /**
     * Selects the scale's base notes, transposing from C rather than the previous pickup's key.
     * @param selectedKey - The selected key.
     * @param scaleName - The name of the scale.
     */
    private selectScale(
        selectedKey: string,
        scaleName: string
    ): void {
        const name = scales[scaleName]?.notes ? scaleName : 'Major';
        let notes = scales[name].notes;

        if (BASE_SCALE_KEY !== selectedKey) {
            let semitoneOffset = keys[selectedKey].semitone - keys[BASE_SCALE_KEY].semitone;

            if (semitoneOffset > 6) {
                semitoneOffset -= 12;
            } else if (semitoneOffset < -6) {
                semitoneOffset += 12;
            }

            notes = transpose(notes, semitoneOffset);
        }

        this.selectedScale = { name, notes };
    }

    /**
     * Gets the next note to play based on the last played note and whether it is the first note.
     * @param lastPlayedNote - The last note that was played.
     * @param isFirstNote - Whether this is the first note to be played.
     * @returns The next note to play.
     */
    private getNote(
        lastPlayedNote?: number,
        isFirstNote: boolean = false
    ): number {
        if (isFirstNote) {
            return this.selectedScale.notes[0];
        }

        const { notes } = this.selectedScale;
        const possibleNextNotes = notes.filter((note) =>
            this.isValidInterval(note, lastPlayedNote!)
        );
        // A key/scale change can leave no admissible interval from the previous note.
        // Restart on the selected tonic rather than send an undefined pitch to Tone.
        if (possibleNextNotes.length === 0) return notes[0];

        const validChordTones = this.getCommonChordTones().filter(note => possibleNextNotes.includes(note));
        const nonChordTones = possibleNextNotes.filter(
            (note) => !validChordTones.includes(note)
        );

        const useChordTone = Math.random() > 0.5;
        const preferredNotes = useChordTone ? validChordTones : nonChordTones;
        const candidates = preferredNotes.length > 0 ? preferredNotes : possibleNextNotes;
        return candidates[Math.floor(Math.random() * candidates.length)];
    }

    /**
     * Checks if the interval between two notes is valid for the selected scale.
     * @param note - The note to check.
     * @param lastPlayedNote - The last note that was played.
     * @returns Whether the interval is valid.
     */
    private isValidInterval(note: number, lastPlayedNote: number): boolean {
        // Inputs are Hz; musical intervals are logarithmic, not frequency differences.
        const semitones = Math.round(12 * Math.log2(note / lastPlayedNote));
        const interval = ((semitones % 12) + 12) % 12;

        const { name } = this.selectedScale;
        return VALID_INTERVALS_BY_SCALE[name]?.includes(interval) || false;
    }

    /**
     * Gets the common chord tones for the selected scale.
     * @returns The common chord tones for the selected scale.
     */
    private getCommonChordTones(): number[] {
        const { name, notes } = this.selectedScale;
        return CHORD_TONE_INDICES_BY_SCALE[name]?.map((index) => notes[index]) || [];
    }

    /**
        * Plays a note using the provided selection.
        *
        * Invariants:
        * - When `selection` is omitted, scale/key are read from the DOM and default to `Major`/`C`.
        * - Unknown scale names fall back to `Major`.
        *
        * @param selection - Optional explicit selection (`key` and `scaleName`).
     */
    playNote(selection?: { key: string; scaleName: string }): void {
        this.playSafely(() => this.selectNote(selection));
    }

    private selectNote(selection?: { key: string; scaleName: string }): number {
        const selectedScale =
            selection?.scaleName ||
            (
                document.querySelector('[data-selected-scale]') as Element | null
            )?.textContent ||
            'Major';

        const selectedKey =
            selection?.key ||
            (
                document.querySelector('[data-selected-key]') as Element | null
            )?.textContent ||
            'C';

        this.selectScale(selectedKey, selectedScale);

        const isFirstNote = !this.lastPlayedNote as boolean;

        const note = this.getNote(this.lastPlayedNote, isFirstNote) as number;
        this.lastPlayedNote = note;

        return note;
    }

    dispose(): void {
        this.synth.dispose();
    }
}
