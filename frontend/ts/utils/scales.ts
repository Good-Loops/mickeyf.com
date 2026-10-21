/**
 * Represents a musical scale.
 * 
 * @interface Scale
 * @property {string} description - A brief description of the scale.
 * @property {number[]} notes - The scale's note frequencies in Hz.
 */
export interface Scale {
    description: string;
    notes: number[];
};

/**
 * A collection of musical scales with their descriptions and note frequencies.
 * Each scale is represented by a key-value pair where the key is the name of the scale
 * and the value is an object containing a description and an array of note frequencies.
 * 
 * Scales included:
 * - Major: Bright, happy, and uplifting. Fundamental to Western music and often used in pop, classical, and folk music.
 * - Minor: Sad, serious, and introspective. Used widely in classical, rock, and pop music to convey deeper emotions.
 * - Pentatonic: Simple, versatile, and pleasing. Found in folk, rock, blues, and pop music. Known for its ease of use in improvisation.
 * - Blues: Gritty, soulful, and expressive. Central to blues, rock, and jazz music. Known for its "blue notes" which add a sense of longing and emotion.
 * - Dorian: Mellow, jazzy, and slightly brighter than the natural minor scale. Common in jazz, rock, and folk music.
 * - Mixolydian: Bluesy, relaxed, and slightly tense. Frequently used in rock, blues, and jazz music.
 * - Phrygian: Exotic, intense, and slightly Spanish-sounding. Used in flamenco, metal, and classical music.
 * - Lydian: Dreamy, ethereal, and bright. Popular in jazz, classical, and film scores for its unique sound.
 * - Locrian: Dark, tense, and unresolved. Rarely used but found in jazz and metal for creating dissonance and tension.
 * - Chromatic: Tense, atonal, and fluid. Used for adding tension, in classical compositions, and for chromatic runs in various genres.
 * - Harmonic Major: A mix of bright and dark, with a slightly exotic feel. Used in jazz and classical music.
 * - Melodic Minor: Versatile, with a mix of minor and major qualities. Used in jazz, classical, and modern music for its smooth melodic lines.
 * - Whole Tone: Mystical, ambiguous, and symmetrical. Used in classical and jazz music to create dreamy and floating atmospheres.
 * - Hungarian Minor: Exotic, dramatic, and folk-like. Found in Eastern European folk music and classical compositions.
 * - Double Harmonic: Intense, Eastern-sounding, and exotic. Used in Middle Eastern and Eastern European music.
 * - Neapolitan Major: Tense, dramatic, and slightly exotic. Used in classical and operatic music.
 * - Neapolitan Minor: Dark, dramatic, and unique. Found in classical music for its emotional depth.
 * - Augmented: Dissonant, symmetrical, and otherworldly. Used in jazz and modern classical music.
 * - Hexatonic: Versatile, simple, and often used in various forms. Found in folk and modern music.
 * - Enigmatic: Mysterious, unconventional, and ambiguous. Rarely used but found in modern classical music for its unique sound.
 * - Spanish Gypsy: Exotic, intense, and Flamenco-like. Central to Flamenco music and used in metal and classical compositions.
 * - Hirajoshi: Eastern, pentatonic, and traditional. Found in Japanese music and used to evoke an Eastern sound.
 * - Balinese Pelog: Exotic, uneven, and traditional. Used in Indonesian gamelan music.
 * - Egyptian: Ancient, exotic, and folk-like. Used in Middle Eastern and African music to create an ancient sound.
 * - Hungarian Gypsy: Rich, exotic, and dramatic. Found in Eastern European folk music and classical compositions.
 * - Persian: Middle Eastern, tense, and exotic. Used in Persian and Middle Eastern music.
 * - Tritone: Tense, symmetrical, and dissonant. Found in jazz and modern classical music.
 * - Flamenco: Passionate, intense, and Spanish. Central to Flamenco music.
 * - Iwato: Dissonant, exotic, and traditional. Found in Japanese music for creating an unusual sound.
 * - Blues Heptatonic: Rich, soulful, and expressive. Extends the traditional blues scale with added notes for more melodic options.
 */
export const scales: { [key: string]: Scale } = {
    'Major': {
        description: 'Bright, happy, and uplifting. Fundamental to Western music and often used in pop, classical, and folk music.',
        notes: [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88, 523.25] // C Major
    },
    'Minor': {
        description: 'Sad, serious, and introspective. Used widely in classical, rock, and pop music to convey deeper emotions.',
        notes: [261.63, 293.66, 311.13, 349.23, 392.00, 415.30, 466.16, 523.25] // C Minor
    },
    'Pentatonic': {
        description: 'Simple, versatile, and pleasing. Found in folk, rock, blues, and pop music. Known for its ease of use in improvisation.',
        notes: [261.63, 293.66, 329.63, 392.00, 440.00, 523.25] // C Major Pentatonic
    },
    'Blues': {
        description: 'Gritty, soulful, and expressive. Central to blues, rock, and jazz music. Known for its "blue notes" which add a sense of longing and emotion.',
        notes: [261.63, 293.66, 311.13, 349.23, 392.00, 415.30, 523.25] // C Blues
    },
    'Dorian': {
        description: 'Mellow, jazzy, and slightly brighter than the natural minor scale. Common in jazz, rock, and folk music.',
        notes: [261.63, 293.66, 311.13, 349.23, 392.00, 440.00, 466.16, 523.25] // C Dorian
    },
    'Mixolydian': {
        description: 'Bluesy, relaxed, and slightly tense. Frequently used in rock, blues, and jazz music.',
        notes: [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 466.16, 523.25] // C Mixolydian
    },
    'Phrygian': {
        description: 'Exotic, intense, and slightly Spanish-sounding. Used in flamenco, metal, and classical music.',
        notes: [261.63, 277.18, 311.13, 349.23, 392.00, 415.30, 466.16, 523.25] // C Phrygian
    },
    'Lydian': {
        description: 'Dreamy, ethereal, and bright. Popular in jazz, classical, and film scores for its unique sound.',
        notes: [261.63, 293.66, 329.63, 370.00, 392.00, 440.00, 493.88, 523.25] // C Lydian
    },
    'Locrian': {
        description: 'Dark, tense, and unresolved. Rarely used but found in jazz and metal for creating dissonance and tension.',
        notes: [261.63, 277.18, 311.13, 349.23, 370.00, 415.30, 466.16, 523.25] // C Locrian
    },
    'Chromatic': {
        description: 'Tense, atonal, and fluid. Used for adding tension, in classical compositions, and for chromatic runs in various genres.',
        notes: [261.63, 277.18, 293.66, 311.13, 329.63, 349.23, 370.00, 392.00, 415.30, 440.00, 466.16, 493.88, 523.25] // C Chromatic
    },
    'Harmonic Major': {
        description: 'A mix of bright and dark, with a slightly exotic feel. Used in jazz and classical music.',
        notes: [261.63, 293.66, 329.63, 349.23, 392.00, 415.30, 493.88, 523.25] // C Harmonic Major
    },
    'Melodic Minor': {
        description: 'Versatile, with a mix of minor and major qualities. Used in jazz, classical, and modern music for its smooth melodic lines.',
        notes: [261.63, 293.66, 311.13, 349.23, 392.00, 440.00, 493.88, 523.25] // C Melodic Minor Ascending
    },
    'Whole Tone': {
        description: 'Mystical, ambiguous, and symmetrical. Used in classical and jazz music to create dreamy and floating atmospheres.',
        notes: [261.63, 293.66, 329.63, 370.00, 415.30, 466.16, 523.25] // C Whole Tone
    },
    'Hungarian Minor': {
        description: 'Exotic, dramatic, and folk-like. Found in Eastern European folk music and classical compositions.',
        notes: [261.63, 293.66, 311.13, 370.00, 392.00, 415.30, 493.88, 523.25] // C Hungarian Minor
    },
    'Double Harmonic': {
        description: 'Intense, Eastern-sounding, and exotic. Used in Middle Eastern and Eastern European music.',
        notes: [261.63, 277.18, 311.13, 349.23, 392.00, 415.30, 493.88, 523.25] // C Double Harmonic
    },
    'Neapolitan Major': {
        description: 'Tense, dramatic, and slightly exotic. Used in classical and operatic music.',
        notes: [261.63, 277.18, 329.63, 349.23, 392.00, 440.00, 493.88, 523.25] // C Neapolitan Major
    },
    'Neapolitan Minor': {
        description: 'Dark, dramatic, and unique. Found in classical music for its emotional depth.',
        notes: [261.63, 277.18, 311.13, 349.23, 392.00, 415.30, 493.88, 523.25] // C Neapolitan Minor
    },
    'Augmented': {
        description: 'Dissonant, symmetrical, and otherworldly. Used in jazz and modern classical music.',
        notes: [261.63, 293.66, 329.63, 370.00, 415.30, 466.16, 523.25] // C Augmented
    },
    'Hexatonic': {
        description: 'Versatile, simple, and often used in various forms. Found in folk and modern music.',
        notes: [261.63, 293.66, 329.63, 392.00, 440.00, 523.25] // C Whole Tone Hexatonic
    },
    'Enigmatic': {
        description: 'Mysterious, unconventional, and ambiguous. Rarely used but found in modern classical music for its unique sound.',
        notes: [261.63, 277.18, 329.63, 370.00, 415.30, 466.16, 493.88, 523.25] // C Enigmatic
    },
    'Spanish Gypsy': {
        description: 'Exotic, intense, and Flamenco-like. Central to Flamenco music and used in metal and classical compositions.',
        notes: [261.63, 277.18, 329.63, 349.23, 392.00, 415.30, 466.16, 523.25] // C Spanish Gypsy
    },
    'Hirajoshi': {
        description: 'Eastern, pentatonic, and traditional. Found in Japanese music and used to evoke an Eastern sound.',
        notes: [261.63, 277.18, 329.63, 392.00, 466.16, 523.25] // C Hirajoshi
    },
    'Balinese Pelog': {
        description: 'Exotic, uneven, and traditional. Used in Indonesian gamelan music.',
        notes: [261.63, 277.18, 311.13, 370.00, 392.00, 523.25] // C Balinese Pelog
    },
    'Egyptian': {
        description: 'Ancient, exotic, and folk-like. Used in Middle Eastern and African music to create an ancient sound.',
        notes: [261.63, 293.66, 311.13, 392.00, 466.16, 523.25] // C Egyptian
    },
    'Hungarian Gypsy': {
        description: 'Rich, exotic, and dramatic. Found in Eastern European folk music and classical compositions.',
        notes: [261.63, 293.66, 311.13, 370.00, 392.00, 415.30, 523.25] // C Hungarian Gypsy
    },
    'Persian': {
        description: 'Middle Eastern, tense, and exotic. Used in Persian and Middle Eastern music.',
        notes: [261.63, 277.18, 311.13, 370.00, 392.00, 415.30, 466.16, 523.25] // C Persian
    },
    'Tritone': {
        description: 'Tense, symmetrical, and dissonant. Found in jazz and modern classical music.',
        notes: [261.63, 293.66, 329.63, 370.00, 415.30, 466.16, 523.25] // C Tritone
    },
    'Flamenco': {
        description: 'Passionate, intense, and Spanish. Central to Flamenco music.',
        notes: [261.63, 277.18, 329.63, 349.23, 392.00, 415.30, 523.25] // C Flamenco
    },
    'Iwato': {
        description: 'Dissonant, exotic, and traditional. Found in Japanese music for creating an unusual sound.',
        notes: [261.63, 277.18, 329.63, 370.00, 523.25] // C Iwato
    },
    'Blues Heptatonic': {
        description: 'Rich, soulful, and expressive. Extends the traditional blues scale with added notes for more melodic options.',
        notes: [261.63, 293.66, 311.13, 349.23, 392.00, 415.30, 523.25] // C Blues Heptatonic
    }
};
