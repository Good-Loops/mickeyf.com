/**
 * Pitch → color “policy” layer.
 *
 * This module is responsible for mapping *stabilized* pitch inputs (and silence) into an HSL color
 * decision suitable for driving visuals.
 *
 * Separation of concerns:
 * - Pitch detection and confidence estimation live elsewhere (e.g. `AudioEngine`).
 * - Pitch stabilization (hysteresis / commit semantics) is handled by the pitch hysteresis tracker.
 * - This policy maps those stable inputs → aesthetic color decisions.
 *
 * Key goals:
 * - Musical coherence: stable pitch classes map to stable hue anchors.
 * - Stability: avoid hue flicker when pitch is noisy.
 * - Aesthetic continuity: allow small “micro drift” within a note, but keep it bounded.
 *
 * Hue in this project is expressed in **degrees** and generally normalized into $[0, 360)$.
 * Saturation/lightness are expressed as **percent** values (typically $[0, 100]$).
 */
import { PitchHysteresis, PitchResult } from "@/animations/helpers/audio/PitchHysteresis";
import { clamp } from "@/utils/clamp";
import { getRandomHsl, HslColor, HslRanges } from "@/utils/hsl";
import { pitchClassToHue } from "@/animations/helpers/audio/pitchClassToHue";

/**
 * @category Color — Support
 */
export type PitchColorPolicyDeps = {
    /** Pitch stabilizer that emits committed pitch-class updates. */
    tracker: PitchHysteresis;
    tuning: {
        /**
         * If `true`, the policy updates the output color only on pitch-class commits.
         *
         * If `false`, the policy can update continuously, including applying micro drift.
         */
        noteStep: boolean;

        /**
         * Max drift applied to the committed hue anchor, in **degrees**.
         *
         * Drift is derived from the pitch’s fractional semitone distance and is clamped.
         */
        microHueDriftDeg: number;

        /** Saturation to use while a pitch is present, in **percent**. */
        pitchSaturation: number;

        /** Lightness to use while a pitch is present, in **percent**. */
        pitchLightness: number;

        /**
         * Range used to pick an idle color after sustained silence.
         *
         * If `hue` is omitted, hue is chosen uniformly from $[0, 360)$.
         */
        silenceRanges: HslRanges;
    };

    /** Optional initial color used before the first pitch-driven decision. */
    initialColor?: HslColor;
};

/**
 * @category Color — Support
 */
export type DecideInput = {
    /** Raw detected pitch in **Hz**. */
    pitchHz: number;

    /** Pitch confidence in $[0, 1]$. */
    clarity: number;

    /** Absolute time, in **milliseconds** (monotonic clock). */
    nowMs: number;

    /** Elapsed time since the previous policy update, in **milliseconds**. */
    dtMs: number;
};

/**
 * Output of {@link PitchColorPolicy.decide}.
 *
 * @category Color — Support
 */
export type ColorDecision = {
    /** HSL decision (degrees + percents) intended to drive downstream color controllers. */
    color: HslColor;

    /** Pitch tracker result for the same step (pitch vs silence, plus commit signal when present). */
    result: PitchResult;
};

/**
 * Maps stabilized pitch to HSL color.
 *
 * This class is stateful:
 * - It stores a “last good” color used during brief silence.
 * - It can (optionally) randomize a new idle color after sustained silence.
 *
 * @category Color — Core
 */
export class PitchColorPolicy {
    private lastGood: HslColor;
    private lastPitchColor: HslColor;

    /**
    * @param deps - Policy dependencies and tuning. The provided pitch hysteresis tracker instance
     * is treated as owned-by-caller and is not disposed by this class.
     */
    constructor(private deps: PitchColorPolicyDeps) {
        this.lastGood = deps.initialColor ?? { hue: 0, saturation: 50, lightness: 50 };
        this.lastPitchColor = this.lastGood;
    }

    /**
     * Computes the current pitch-driven color decision.
     *
     * @remarks
     * Heuristics (high level):
     * - Silence holds the last color; after sustained silence, picks a new idle color from `silenceRanges`.
     * - Pitch hue is anchored to the committed pitch class (`pitchClassToHue`).
     * - Micro drift offsets hue by a bounded amount based on fractional semitone distance.
     * - If `noteStep` is enabled, pitch color changes only on commits; returning from silence restores it.
     *
     * Determinism: given the same internal state and inputs, results are deterministic except when
     * sustained silence triggers a random idle color.
     */
    decide({ pitchHz, clarity, nowMs, dtMs }: DecideInput): ColorDecision {
        const { tracker, tuning } = this.deps;

        const result = tracker.update({ pitchHz, clarity, nowMs, dtMs });

        if (result.kind === "silence") {
            const silentLong = tracker.isSilentLongEnough();
            if (silentLong) this.lastGood = getRandomHsl(tuning.silenceRanges);

            return {
                color: this.lastGood,
                result,
            };
        }

        const fracNorm = result.fractionalDistance / tracker.microSemitoneRange;
        const hueOffset = clamp(fracNorm, -1, 1) * tuning.microHueDriftDeg;

        const committedPitchClass = result.pitchClass;
        const committedBaseHue = pitchClassToHue(committedPitchClass);
        const finalHue = (committedBaseHue + hueOffset + 360) % 360;

        if (tuning.noteStep && !result.changed) {
            // Idle colors must not replace the pitch anchor when the same note resumes.
            this.lastGood = this.lastPitchColor;
            return {
                color: this.lastGood,
                result,
            };
        }

        this.lastGood = {
            hue: finalHue,
            saturation: tuning.pitchSaturation,
            lightness: tuning.pitchLightness,
        };
        this.lastPitchColor = this.lastGood;

        return {
            color: this.lastGood,
            result,
        };
    }

    /** Most recent non-silence (or idle) color chosen by the policy. */
    get lastGoodColor(): HslColor { return this.lastGood; }
}
