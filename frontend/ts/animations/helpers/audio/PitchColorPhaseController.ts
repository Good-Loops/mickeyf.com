/**
 * Pitch-color phase controller.
 *
 * Maintains a smooth, continuous hue/color state over time, so visuals can react to musical events
 * (pitch commits, silence) without abrupt jumps.
 *
 * Relationship to {@link PitchColorPolicy}:
 * - The policy produces discrete decisions/targets (including pitch-class commits).
 * - This controller integrates those targets over time (smoothing + drift) and outputs a stable
 *   color each frame.
 *
 * Units/conventions:
 * - Time inputs are in **milliseconds** (`nowMs`, `deltaMs`). Internal oscillators convert to seconds.
 * - Hue is in **degrees** and wrapped into $[0, 360)$ using {@link wrapHue}.
 * - Internal LFO “phase” values are in **radians**.
 */
import { PitchColorPolicy, type ColorDecision } from "@/animations/helpers/audio/PitchColorPolicy";
import { clamp } from "@/utils/clamp";
import { expSmoothing } from "@/utils/expSmoothing";
import { HslColor, lerpHsl, signedHueDistance, wrapHue } from "@/utils/hsl";

type CommitTransition = {
    active: boolean;
    color: HslColor;
};

type PitchColorPhaseState = {
    committedHueBase: number;
    committedColorBase: HslColor | null;
    committedAtMs: number;
    colorAnchorKind: "silence" | "pitch" | null;
    holdListening: boolean;
    holdHueLfoPhase: number;
    stableLfoPhase: number;
    localSilenceMs: number;
    colorElapsedMs: number;
    renderedColor: HslColor;
    commitTransition: CommitTransition;
    lastPitchChanged: boolean;
    lastKind: "silence" | "pitch";
};

/**
 * @category Color — Support
 */
export type PitchColorPhaseTuning = {
    colorIntervalMs: number;
    listenAfterSilenceMs: number;
    
    holdDrift: {
        deg: number;
        hz: number;
    };

    stableDrift: {
        rampMs: number;
        hz: number;
        hueDeg: number;
        satDeg: number;
        lightDeg: number;
    };

    commit: {
        holdMs: number;
        smoothingResponsiveness: number;
    };
    noteStep: boolean;
};

/**
 * @category Color — Support
 */
export type PitchColorPhaseStepInput = {
    /** Raw detected pitch in **Hz**. */
    pitchHz: number;

    /** Pitch confidence in $[0, 1]$. */
    clarity: number;

    /** Absolute time, in **milliseconds** (monotonic clock). */
    nowMs: number;

    /** Elapsed time since the previous `step`, in **milliseconds**. */
    deltaMs: number;
};

/**
 * @category Color — Support
 */
export type PitchColorPhaseStepResult = {
    /** Render-ready HSL color (degrees + percents), after smoothing/drift is applied. */
    color: HslColor;

    /**
     * Optional policy decision that was sampled this step.
     *
     * When omitted, the controller is reusing the previous decision/target and only evolving
     * internal phase/smoothing.
     */
    decision?: ColorDecision;
};

/**
 * Evolves pitch-driven color over time.
 *
 * State held by this controller includes commit timing, silence timers, smoothing accumulators,
 * and LFO phases used for “breathing” drift.
 *
 * @category Color — Core
 */
export class PitchColorPhaseController {
    private state: PitchColorPhaseState;

    constructor(
        private deps: {
            policy: PitchColorPolicy;
            tuning: PitchColorPhaseTuning;
        }
    ) {
        const initialColor = deps.policy.lastGoodColor;

        this.state = {
            committedHueBase: 0,
            committedColorBase: null,
            committedAtMs: 0,
            colorAnchorKind: null,
            holdListening: true,
            holdHueLfoPhase: 0,
            stableLfoPhase: 0,
            localSilenceMs: 0,
            colorElapsedMs: 0,
            renderedColor: initialColor,
            commitTransition: {
                active: false,
                color: initialColor,
            },
            lastPitchChanged: false,
            lastKind: "silence",
        };
    }

    /** Resets internal phase/state to the policy’s current `lastGoodColor`. */
    reset(): void {
        const initialColor = this.deps.policy.lastGoodColor;

        this.state = {
            committedHueBase: 0,
            committedColorBase: null,
            committedAtMs: 0,
            colorAnchorKind: null,
            holdListening: true,
            holdHueLfoPhase: 0,
            stableLfoPhase: 0,
            localSilenceMs: 0,
            colorElapsedMs: 0,
            renderedColor: initialColor,
            commitTransition: {
                active: false,
                color: initialColor,
            },
            lastPitchChanged: false,
            lastKind: "silence",
        };
    }

    /**
     * Advances the controller by one frame.
     *
     * Call frequency: typically once per render tick.
     *
     * Wrapping guarantees:
     * - Returned hue is wrapped into $[0, 360)$.
     * - Saturation/lightness are clamped to $[0, 100]$ where drift is applied.
     *
     * Determinism: given the same input stream and policy behavior, output is deterministic.
     *
     * @param input.deltaMs - Frame delta in **milliseconds**.
     * @param input.nowMs - Absolute time in **milliseconds**.
     */
    step(input: PitchColorPhaseStepInput): PitchColorPhaseStepResult {
        this.state.colorElapsedMs += input.deltaMs;

        if (this.state.colorAnchorKind !== null && !this.state.holdListening) {
            return this.handleHoldPhase(input);
        }

        const decision = this.deps.policy.decide({
            pitchHz: input.pitchHz,
            clarity: input.clarity,
            nowMs: input.nowMs,
            dtMs: this.state.colorElapsedMs,
        });

        this.updateKindFlags(decision, this.state.colorElapsedMs);

        const isCommit =
            decision.result.kind === "pitch" &&
            decision.result.changed === true;

        const shouldUpdatePolicy = isCommit || this.state.colorElapsedMs >= this.deps.tuning.colorIntervalMs;

        if (!shouldUpdatePolicy) {
            return { color: this.renderCurrent(input), decision: undefined };
        }

        const elapsedMs = this.state.colorElapsedMs;
        this.state.colorElapsedMs = 0;

        this.updateSilence(decision, elapsedMs);

        // After a reset during silence, the tracker can resume the same note
        // without a new commit, but rendering still needs a musical anchor.
        const needsPitchAnchor =
            decision.result.kind === "pitch" && this.state.colorAnchorKind !== "pitch";

        if (isCommit || this.state.colorAnchorKind === null || needsPitchAnchor) {
            this.startCommit(decision, input.nowMs);
        }

        return { color: this.renderCurrent(input), decision };
    }

    private updateKindFlags(decision: ColorDecision, colorElapsedMs: number): void {
        const nextLocalSilenceMs =
            decision.result.kind === "silence"
            ? this.state.localSilenceMs + colorElapsedMs
            : 0;

        const isBriefSilence =
            decision.result.kind === "silence" &&
            this.state.colorAnchorKind !== null &&
            nextLocalSilenceMs < this.deps.tuning.listenAfterSilenceMs;

        const effectiveKind: "silence" | "pitch" =
            isBriefSilence ? "pitch" : decision.result.kind;

        this.state.lastKind = effectiveKind;

        this.state.lastPitchChanged =
            effectiveKind === "pitch" && decision.result.kind === "pitch"
            ? decision.result.changed
            : false;
    }

    private shouldStableDrift(): boolean {
        return (
            this.state.colorAnchorKind !== null &&
            this.state.lastKind === "pitch" &&
            this.state.lastPitchChanged === false
        );
    }

    private renderCurrent(input: PitchColorPhaseStepInput): HslColor {
        let color = this.progressCommitTransition(input.deltaMs);
        if (this.shouldStableDrift()) {
            color = this.applyStableDrift(color, input);
        }
        this.state.renderedColor = color;
        return color;
    }

    private startCommit(decision: ColorDecision, nowMs: number): void {
        const color = decision.color;
        this.state.committedColorBase = color;
        this.state.committedHueBase = color.hue;
        this.state.committedAtMs = nowMs;

        const startingColor = this.state.colorAnchorKind !== null
            ? this.state.renderedColor
            : color;

        this.state.commitTransition = {
            active: this.state.colorAnchorKind !== null,
            color: startingColor,
        };

        this.state.holdHueLfoPhase = 0;
        this.state.stableLfoPhase = 0;
        this.state.colorAnchorKind = decision.result.kind;
        this.state.holdListening = false;
    }

    private handleHoldPhase(input: PitchColorPhaseStepInput): PitchColorPhaseStepResult {
        const elapsedMs = this.state.colorElapsedMs;
        const holdDurationMs = input.nowMs - this.state.committedAtMs;

        if (holdDurationMs >= this.deps.tuning.commit.holdMs) {
            this.state.holdListening = true;
            this.state.localSilenceMs = 0;
            this.state.colorElapsedMs = 0;
        }

        let color = this.progressCommitTransition(input.deltaMs);

        if (!this.state.holdListening && elapsedMs >= this.deps.tuning.colorIntervalMs) {
            this.state.colorElapsedMs = 0;
            color = this.applyHoldDrift(color, input);
        }

        this.state.renderedColor = color;

        return {
            color,
        };
    }

    private applyHoldDrift(baseColor: HslColor, input: PitchColorPhaseStepInput): HslColor {
        const dtSec = input.deltaMs / 1000;
        this.state.holdHueLfoPhase +=
            dtSec * (this.deps.tuning.holdDrift.hz * Math.PI * 2);

        const sinceCommitMs = input.nowMs - this.state.committedAtMs;
        const SETTLE_TIME_MS = 400;
        const settle = 1 - clamp(sinceCommitMs / SETTLE_TIME_MS, 0, 1);

        const wave = this.smoothBreathingWave(this.state.holdHueLfoPhase);
        const drift = wave * this.deps.tuning.holdDrift.deg * settle;

        return {
            ...baseColor,
            hue: wrapHue(this.state.committedHueBase + drift),
        };
    }

    private applyStableDrift(base: HslColor, input: PitchColorPhaseStepInput): HslColor {
        const t = this.deps.tuning.stableDrift;

        const sinceCommitMs = input.nowMs - this.state.committedAtMs;
        const rampLinear = t.rampMs <= 0 ? 1 : clamp(sinceCommitMs / t.rampMs, 0, 1);
        const ramp = rampLinear * rampLinear * (3 - 2 * rampLinear);

        const dtSec = input.deltaMs / 1000;
        this.state.stableLfoPhase += dtSec * (t.hz * Math.PI * 2);

        const centered = this.continuousBreathingWave(this.state.stableLfoPhase);

        const hue = wrapHue(base.hue + centered * t.hueDeg * ramp);
        const saturation = clamp(base.saturation + centered * t.satDeg * ramp, 0, 100);
        const lightness = clamp(base.lightness + centered * t.lightDeg * ramp, 0, 100);

        return { hue, saturation, lightness };
    }

    /**
     * Generates a smooth, unidirectional breathing wave (0..1 range).
     * Uses sin^2 for a gentle, rounded oscillation without sharp peaks.
     */
    private smoothBreathingWave(phase: number): number {
        return Math.sin(phase) ** 2;
    }

    /**
     * Generates a smooth, continuous breathing wave centered at 0 (-1..1 range).
     * Combines two harmonically related cosine waves for organic movement.
     */
    private continuousBreathingWave(phase: number): number {
        const PRIMARY_WEIGHT = 0.7;
        const SECONDARY_WEIGHT = 0.3;
        
        const primary = 0.5 - 0.5 * Math.cos(phase);
        const secondary = 0.5 - 0.5 * Math.cos(phase * 0.5);
        const breath = primary * PRIMARY_WEIGHT + secondary * SECONDARY_WEIGHT;
        return (breath - 0.5) * 2;
    }

    private progressCommitTransition(deltaMs: number): HslColor {
        const target = this.state.committedColorBase ?? this.state.renderedColor;

        if (!this.state.commitTransition.active || !target) {
            return target;
        }

        const alpha = expSmoothing(deltaMs, this.deps.tuning.commit.smoothingResponsiveness);

        const nextColor = lerpHsl(
            this.state.commitTransition.color,
            target,
            alpha
        );

        this.state.commitTransition.color = nextColor;

        const hueDelta = signedHueDistance(nextColor.hue, target.hue);
        const saturationDelta = Math.abs(nextColor.saturation - target.saturation);
        const lightnessDelta = Math.abs(nextColor.lightness - target.lightness);

        const SETTLED_HUE_EPS_DEG = 0.1;
        const SETTLED_SAT_EPS_DEG = 0.5;
        const SETTLED_LIGHT_EPS_DEG = 0.5;

        const isSettled =
            Math.abs(hueDelta) < SETTLED_HUE_EPS_DEG &&
            saturationDelta < SETTLED_SAT_EPS_DEG &&
            lightnessDelta < SETTLED_LIGHT_EPS_DEG;

        if (isSettled) {
            this.state.commitTransition = {
                active: false,
                color: target,
            };
            return target;
        }

        return nextColor;
    }

    private updateSilence(decision: ColorDecision, elapsedMs: number): void {
        if (decision.result.kind === "silence") {
            this.state.localSilenceMs += elapsedMs;

            if (this.state.localSilenceMs >= this.deps.tuning.listenAfterSilenceMs) {
                this.state.holdHueLfoPhase = 0;
                this.state.holdListening = true;
                this.state.localSilenceMs = 0;
                this.state.colorElapsedMs = 0;
            }
        } else {
            this.state.localSilenceMs = 0;
        }
    }

}
