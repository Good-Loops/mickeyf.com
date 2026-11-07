/**
 * Host/runner contract for “dancing fractals”.
 *
 * A {@link FractalHost} orchestrates a single active `FractalAnimation` instance at a time:
 * it wires a PIXI `Application` + canvas into a container, integrates with the ticker, and manages
 * high-level lifecycle (swap/restart/config patches/disposal).
 *
 * Ownership: the host owns creation and disposal of the PIXI `Application` and its canvas.
 *
 * The host is **not** responsible for animation-specific visuals, fractal math, or per-animation
 * policy decisions; those live inside each `FractalAnimation` implementation.
 *
 * Lifecycle (typical): create host → setFractal (init) → per-frame stepping → updateConfig → dispose.
 */
import type { FractalAnimationConstructor } from "./FractalAnimation";

/**
 * Drives `FractalAnimation` instances while keeping them SRP-focused.
 *
 * Invariants callers can rely on:
 * - At most one animation instance is active at a time.
 * - Configuration patching and lifecycle calls are issued by the host; the animation owns visuals/state.
 *
 * Thread model: methods are expected to be called from the main JS/UI thread.
 *
 * @category Animations — Core
 */
export interface FractalHost {
    /**
     * Replaces the active animation with a new instance.
     *
     * The host reuses the same PIXI `Application` + canvas, disposing the previous animation's
     * resources first (via the animation's disposal flow).
     *
     * @param Fractal - Animation class/constructor to instantiate.
     * @param config - Full initial configuration for the new instance.
     */
    setFractal<C>(Fractal: FractalAnimationConstructor<C>, config: C): void;

    /**
     * Applies a configuration patch to the active animation.
     *
     * Invariants:
     * - Patch type should correspond to the config type `C` used with {@link setFractal}.
     * - If no animation is active, this is a no-op.
     */
    updateConfig<C>(patch: Partial<C>): void;

    /**
     * Restarts the active animation using the last stored configuration.
     *
     * If no animation is active (or no config has been stored yet), this is a no-op.
     */
    restart(): void;

    /**
     * Configures automatic disposal timing.
     *
     * When an animation is active, setting a lifetime re-arms its disposal countdown.
     * Disabling cancels the pending countdown; a fade already started continues.
     *
     * @param seconds - Lifetime in **seconds**. Use `null` to disable auto-disposal.
     */
    setLifetime(seconds: number | null): void;

    /**
     * Returns lightweight runtime stats.
     *
     * - `fps` is a smoothed estimate of frames per second.
     * - `remainingLifetime` is remaining time until disposal begins, in **seconds**, or `null` when
     *   auto-disposal is disabled.
     */
    getStats(): { 
        fps: number;
        remainingLifetime: number | null; 
    };

    /**
     * Disposes the host and all owned resources.
     *
     * This removes the canvas from the DOM, stops ticker integration, and disposes the active
     * animation (if any) along with the underlying PIXI `Application`.
     *
     * Calling this multiple times is safe; after disposal, the host must not be used again.
     */
    dispose(): void;
}
