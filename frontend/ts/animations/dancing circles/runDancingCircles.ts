/**
 * Dancing Circles runner/composition root.
 *
 * Purpose:
 * - Boots the Dancing Circles subsystem and wires it into the app frame loop.
 * - Orchestrates controller, renderer, time state, and audio-derived feature plumbing.
 *
 * Ownership boundaries:
 * - This module coordinates setup and teardown of the PIXI {@link Application} and the per-frame ticker callback.
 * - It does not own the underlying circle dynamics, rendering details, or tuning logic; those live in the
 *   controller/renderer/tuning modules.
 */
import { Application, Graphics } from "pixi.js";

import { CANVAS_HEIGHT, CANVAS_WIDTH } from "@/utils/constants";

import { audioEngine } from "@/animations/helpers/audio/AudioEngine";
import { PitchHysteresis } from "@/animations/helpers/audio/PitchHysteresis";
import { PitchColorPolicy } from "@/animations/helpers/audio/PitchColorPolicy";
import { PitchColorPhaseController } from "@/animations/helpers/audio/PitchColorPhaseController";
import { BeatEnvelope } from "@/animations/helpers/audio/BeatEnvelope";

import { TUNING } from "./tuning";
import { createTimeState, resetControlElapsed, resetIdleElapsed } from "./timeState";
import { createRenderer } from "@/animations/dancing circles/renderer";

import { Circle } from "./classes/Circle";
import { CircleBounds } from "./classes/CircleBounds";
import { DancingCirclesController, AudioParams, BeatFrame, BeatMove } from "@/animations/dancing circles/DancingCirclesController";
import { clamp } from "@/utils/clamp";

type DancingCirclesDeps = {
    container: HTMLElement;
};

export const DEFAULT_DANCING_CIRCLES_CUSTOM_COLOR = '#46515b';

/**
 * Starts the Dancing Circles animation inside the provided DOM container.
 *
 * Called by an app-level entry point (e.g. page/route activation). This function initializes PIXI,
 * creates controller + renderer instances, and registers a per-frame tick handler.
 *
 * Ownership & lifetime:
 * - Retains the created PIXI {@link Application} and ticker callback until the returned disposer is called.
 * - The `container` element is used to attach the PIXI canvas; the canvas is removed during cleanup.
 *
 * @returns A disposer function that unregisters the frame callback and destroys PIXI resources.
 */
export async function runDancingCircles({ container }: DancingCirclesDeps) {
    const app = new Application();

    await app.init({
        antialias: true,
        backgroundAlpha: 0,
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
    });
    
    const startMs = performance.now();
    const getNowMs = () => performance.now() - startMs;

    app.canvas.classList.add("dancing-circles__canvas");
    app.canvas.setAttribute("role", "img");
    app.canvas.setAttribute("aria-label", "Dancing Circles animation");
    container.append(app.canvas);

    const bounds = new CircleBounds(CANVAS_WIDTH, CANVAS_HEIGHT);
    const circles = Array.from({ length: 12 }, (_, i) => 
        new Circle({ index: i, gap: 14, colorRanges: {
            saturation: [95, 100],
            lightness: [60, 80],
    }}));

    const beatMove: BeatMove = {
        lastMoveAtMs: -Infinity,
    };

    const beatFrame: BeatFrame = {
        envelope: 0,
        moveGroup: 0 as 0 | 1,
    };

    const beatEnvelope = new BeatEnvelope({
        gateCooldownMs: TUNING.beat.env.gateCooldownMs,
        attack: TUNING.beat.env.attack,
        decay: TUNING.beat.env.decay,
        strengthPower: TUNING.beat.env.strengthPower,
        strengthScale: TUNING.beat.env.strengthScale,
    });

    const pitchTracker = new PitchHysteresis({
        minClarity: TUNING.color.minClarity,
        minHz: 20,
        holdAfterSilenceMs: TUNING.color.holdAfterSilenceMs,
        minStableMs: TUNING.color.minStableMs,
        minHoldMs: TUNING.color.minHoldMs,
        smoothingBase: 0.08,
        smoothingClarityScale: 0.32,
        microSemitoneRange: 0.65,
        deadbandFrac: 0.5,
    });

    const colorPolicy = new PitchColorPolicy({
        tracker: pitchTracker,
        tuning: {
            noteStep: TUNING.color.noteStep,
            microHueDriftDeg: TUNING.color.microHueDriftDeg,
            pitchSaturation: TUNING.color.pitchSaturation,
            pitchLightness: TUNING.color.pitchLightness,
            silenceRanges: {
                saturation: TUNING.color.silenceRanges.saturation,
                lightness: TUNING.color.silenceRanges.lightness,
            },
        },
    });

    const pitchColorController = new PitchColorPhaseController({
        policy: colorPolicy,
        tuning: {
            colorIntervalMs: TUNING.intervals.colorIntervalMs,
            listenAfterSilenceMs: TUNING.color.listenAfterSilenceMs,
            holdDrift: TUNING.color.holdDrift,
            stableDrift: TUNING.color.stableDrift,
            commit: {
                holdMs: TUNING.color.commit.holdMs,
                smoothingResponsiveness: TUNING.color.commit.smoothingResponsiveness,
            },
            noteStep: TUNING.color.noteStep,
        },
    });

    const { state: time, tick: tickTime } = createTimeState();

    const controller = new DancingCirclesController({
        bounds,
        circles,
        beatFrame,
        beatMove,
        pitchColorController,
        beatEnvelope,
        tuning: TUNING,
        time,
    });

    const getAudioParams = (): AudioParams => {
        const isPlaying = audioEngine.state.playing;

        return {
            isPlaying,
            volumePercentage: audioEngine.getVolumePercentage(audioEngine.state.volumeDb),
            clarity: clamp(audioEngine.state.clarity, 0, 1),
            pitchHz: audioEngine.state.pitchHz,
        };
    };

    // Initial ordering is part of composition (affects draw order).
    const load = (): void => {
        circles.sort(
            (circleA, circleB) => circleB.currentRadius - circleA.currentRadius
        );
    };

    const graphics = new Graphics();
    app.stage.addChild(graphics);

    const renderFrame = createRenderer(
        graphics,
        bounds,
        TUNING
    );

    let wasPlaying = false;

    /**
     * Frame loop integration: called once per ticker frame.
     *
     * Ordering (high-level):
     * - Advance time state
     * - Read audio parameters and derive beat envelope
     * - Step controller targets on configured intervals
     * - Render the current circle state
     */
    const onTick = () => {
        tickTime(getNowMs(), app.ticker.deltaMS);

        const audio = getAudioParams();

        if (audio.isPlaying && !wasPlaying) {
            pitchTracker.reset();
            beatEnvelope.reset();
            pitchColorController.reset();
        }
        wasPlaying = audio.isPlaying;

        const isBeat = audio.isPlaying && audioEngine.state.beat.isBeat;
        const strength = audioEngine.state.beat.strength;

        const { envelope, moveGroup } = beatEnvelope.step({
            dtMs: time.deltaMs,
            nowMs: time.nowMs,
            isBeat,
            strength,
        });

        beatFrame.envelope = envelope;
        beatFrame.moveGroup = moveGroup;

        if (time.idleElapsedMs >= TUNING.intervals.idleTargetUpdateIntervalMs) {
            controller.updateIdle(audio.isPlaying);
            resetIdleElapsed(time);
        }

        if (time.controlElapsedMs >= TUNING.intervals.controlTargetUpdateIntervalMs) {
            controller.updateForAudio(audio);
            resetControlElapsed(time);
        }

        renderFrame(
            circles,
            audio.clarity, 
            audio.isPlaying,
            beatFrame,
            time.deltaMs
        );
    };
    app.ticker.add(onTick);

    load();

    return () => {
        app.ticker.remove(onTick);
        app.canvas.remove();
        app.destroy(true, { children: true, texture: true });
    };
}
