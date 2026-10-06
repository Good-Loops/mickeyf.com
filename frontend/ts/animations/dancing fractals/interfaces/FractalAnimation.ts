/**
 * Defines the contract for a fractal-like PIXI animation that is driven by a host/ticker.
 *
 * A {@link FractalAnimation} is a small, self-contained render/update unit:
 * - **init** → called once to attach display objects and allocate resources
 * - **step** → called every frame on the host's ticker
 * - **scheduleDisposal** → arms a delayed disposal transition
 *
 * Separation of concerns:
 * - The animation owns its visuals and internal state.
 * - The host owns the PIXI app, ticker, canvas, and high-level lifecycle (swap/restart/dispose).
 *
 * This interface is intentionally minimal so implementations stay SRP-focused and remain easy to host.
 */
import type { AudioState } from '@/animations/helpers/audio/AudioEngine';
import type { MusicFeaturesFrame } from '@/animations/helpers/music/MusicFeatureExtractor';
import type { Application } from 'pixi.js';

/**
 * @typeParam C - Configuration shape for the animation (the set of tunables the host/UI can patch).
 *
 * - All methods are expected to be called from the main render loop (single-threaded JavaScript).
 */
/**
 * @category Animations — Core
 */
export interface FractalAnimation<C> {
    /**
     * Called exactly once after construction and before the first frame is rendered.
     * Use this to create PIXI/GPU resources and attach display objects to the provided app/stage.
     *
     * The host is expected to call this once per instance; implementations do not need to be
     * idempotent unless they choose to be.
     */
    init(app: Application): void;

    /**
     * Performance: keep this allocation-light; avoid per-frame heavy allocations where possible.
     *
     * @param deltaSeconds - Elapsed time since the previous frame, in **seconds**.
     * @param nowMs - Absolute time since app start, in **milliseconds** (monotonic).
     * @param audioState - Snapshot of current audio analysis/state for this frame.
     * @param musicFeatures - Extracted music features for this frame.
     */
    step(deltaSeconds: number, nowMs: number, audioState: AudioState, musicFeatures: MusicFeaturesFrame): void;

    /**
     * Implementations must merge this patch with the existing config (e.g. shallow-merge) and
     * handle missing fields safely.
     *
     * Must not reset unrelated state unless that behavior is explicitly part of the config contract.
     */
    updateConfig(patch: Partial<C>): void;

    /**
     * Arms an animated disposal transition after a delay.
     *
     * The delay is relative to the call time and is specified in **seconds**.
     *
     * Project convention: this is safe to call multiple times; the latest call re-arms the countdown
     * (and typically resets any in-progress disposal transition).
     *
     * Note: this only schedules the transition. Actual resource cleanup happens via {@link dispose}
     * as part of the animation/host disposal flow.
     *
     * @param seconds - Time from now until disposal starts, in **seconds**.
     */
    scheduleDisposal(seconds: number): void;

    /** Cancels a pending automatic countdown without reversing a fade already in progress. */
    cancelScheduledDisposal(): void;

    startDisposal(): void;

    /**
     * After this is called, the instance must not be used again.
     */
    dispose(): void;
}

/**
 * Constructor type for FractalAnimation implementations.
 *
 * @category Animations — Core
 */
export interface FractalAnimationConstructor<C> {
    /**
     * Creates an animation instance centered at the given coordinates (in canvas pixels).
     */
    new (
        centerX: number, 
        centerY: number,
        initialConfig?: C
    ): FractalAnimation<C>;

    /**
     * Disposal transition duration, in **seconds**.
     */
    disposalSeconds: number;

    /**
     * Background color used by the host to theme the PIXI renderer for this animation.
     */
    backgroundColor: string;
}
