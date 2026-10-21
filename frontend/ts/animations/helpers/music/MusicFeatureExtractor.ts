/**
 * Music feature extraction contract.
 *
 * Produces a per-frame {@link MusicFeaturesFrame} from the current audio state.
 *
 * Separation of concerns:
 * - `AudioEngine` owns WebAudio capture/analysis and exposes raw-ish signals (pitch Hz, clarity,
 *   beat heuristic state, playback flags).
 * - `MusicFeatureExtractor` translates those signals into stable, animation-friendly features
 *   (envelopes, weights, and a pitch-driven color stream).
 */
import type { AudioState } from "@/animations/helpers/audio/AudioEngine";
import type { ColorDecision } from "@/animations/helpers/audio/PitchColorPolicy";
import type { BeatEnvelope } from "@/animations/helpers/audio/BeatEnvelope";
import type { PitchColorPhaseController } from "@/animations/helpers/audio/PitchColorPhaseController";
import { clamp } from "@/utils/clamp";
import type { HslColor } from "@/utils/hsl";

/**
 * Output features for a single frame.
 *
 * Conventions:
 * - All `*01` fields are normalized to $[0, 1]$.
 * - `nowMs`/`deltaMs` are in **milliseconds**.
 * - “Pulse” fields are edge-triggered and are typically `true` for a single frame.
 *
 * @category Audio — Support
 */
export type MusicFeaturesFrame = {
    /** Absolute time, in **milliseconds** (monotonic clock). */
    nowMs: number;

    /** Elapsed time since the previous frame, in **milliseconds**. */
    deltaMs: number;

    /** `true` when audio is available and currently playing. */
    hasMusic: boolean;

    /**
     * Overall “music present” weight in $[0, 1]$.
     *
     * This is derived from clarity and gated by {@link hasMusic}. It is intended as a relative
     * intensity/enable signal for visuals rather than a physical measurement.
     */
    musicWeight01: number;

    /** Beat boolean from the upstream beat heuristic (transient). */
    isBeat: boolean;

    /** Beat strength in $[0, 1]$ (normalized upstream, clamped here). */
    beatStrength01: number;

    /** Smoothed beat envelope in $[0, 1]$ (continuous). */
    beatEnv01: number;

    /** Beat “hit” pulse: `true` only on the envelope trigger frame. */
    beatHit: boolean;

    /** Beat group toggle emitted by {@link BeatEnvelope} (`0 | 1`). */
    moveGroup: 0 | 1;

    /** Raw detected pitch in **Hz** (may be `NaN`/`Infinity` if upstream provides it). */
    pitchHz: number;

    /** Pitch confidence in $[0, 1]$ (clamped). */
    clarity01: number;

    /** Render-ready HSL color derived from pitch policy/controller (hue in degrees). */
    pitchColor: HslColor;

    /** Optional metadata from the pitch policy step (commit/silence info). */
    pitchDecision?: ColorDecision;
};

/**
 * Combines beat/pitch feature extractors into a single per-frame feature stream.
 *
 * @category Audio — Core
 */
export class MusicFeatureExtractor {
    constructor(
        private deps: {
            beatEnvelope: BeatEnvelope;
            pitchColor: PitchColorPhaseController;

            /** Clarity threshold where `musicWeight01` begins to rise (typically in $[0, 1]$). */
            clarityMin: number;

            /** Clarity threshold where `musicWeight01` reaches 1 (typically in $[0, 1]$). */
            clarityFull: number;
        }
    ) {}

    /** Resets all internal extractor/controller state. */
    reset(): void {
        this.deps.beatEnvelope.reset();
        this.deps.pitchColor.reset();
    }

    /**
     * Steps feature extraction for one frame.
     *
     * Call frequency: typically once per render tick.
     *
     * @param args.deltaSeconds - Frame delta in **seconds**.
     * @param args.nowMs - Absolute time in **milliseconds**.
     */
    step(args: {
        deltaSeconds: number;
        nowMs: number;
        audioState: AudioState;
    }): MusicFeaturesFrame {
        const { deltaSeconds, nowMs, audioState } = args;
        const deltaMs = deltaSeconds * 1000;

        const hasMusic = !!audioState.hasAudio && !!audioState.playing;

        const beat = this.deps.beatEnvelope.step({
            dtMs: deltaMs,
            nowMs,
            // Paused/ended audio retains its last analysis snapshot.
            isBeat: hasMusic && audioState.beat.isBeat,
            strength: audioState.beat.strength,
        });

        const pitch = this.deps.pitchColor.step({
            pitchHz: audioState.pitchHz,
            clarity: audioState.clarity,
            nowMs,
            deltaMs,
        });

        const c0 = this.deps.clarityMin;
        const c1 = this.deps.clarityFull;

        const clarity01 = clamp(audioState.clarity, 0, 1);
        const denom = Math.max(1e-6, c1 - c0);

        const musicWeight01 = hasMusic
            ? clamp((clarity01 - c0) / denom, 0, 1)
            : 0;

        return {
            nowMs,
            deltaMs,

            hasMusic,
            musicWeight01,

            isBeat: audioState.beat.isBeat,
            beatStrength01: clamp(audioState.beat.strength, 0, 1),
            beatEnv01: clamp(beat.envelope, 0, 1),
            beatHit: beat.didTrigger,
            moveGroup: beat.moveGroup,

            pitchHz: audioState.pitchHz,
            clarity01,

            pitchColor: pitch.color,
            pitchDecision: pitch.decision,
        };
    }
}
