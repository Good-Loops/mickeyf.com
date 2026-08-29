/**
 * Creates and wires the concrete `FractalHost` implementation for the dancing-fractals page.
 *
 * This module owns the PIXI `Application`, the ticker binding, and the canvas element appended to the
 * provided container. The caller owns the mount element and overall page/routing lifecycle.
 *
 * Design constraints:
 * - Keep the per-frame ticker path allocation-light.
 * - Ensure disposal is deterministic: detach ticker, remove canvas, and destroy PIXI resources.
 */
import { Application, Ticker } from "pixi.js";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "@/utils/constants";
import type { FractalAnimationConstructor } from "./interfaces/FractalAnimation";
import type { FractalAnimation } from "./interfaces/FractalAnimation";
import type { FractalHost } from "./interfaces/FractalHost";
import { audioEngine } from "@/animations/helpers/audio/AudioEngine";
import { createMusicFeatureExtractor } from "@/animations/helpers/music/createMusicFeatureExtractor";

/**
 * Instantiates a PIXI `Application`, mounts its canvas into `container`, and returns a host that can
 * swap/restart a single active fractal animation, apply config patches, and dispose resources.
 * The canvas is initialized at `CANVAS_WIDTH` × `CANVAS_HEIGHT` pixels.
 *
 * @param container - Mount point element that will receive the PIXI canvas.
 * @returns A `FractalHost` that drives one active animation instance at a time. After `dispose()`,
 * the returned host must not be used again.
 *
 * @category Animations — Core
 */
export async function createFractalHost(container: HTMLElement): Promise<FractalHost> {
    const app = new Application();

    // Dev hook for debugging in the browser console.
    (globalThis as any).__PIXI_APP__ = app;

    await app.init({
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        preference: 'webgl',
    });

    const initialPathname = window.location.pathname;
    let destroyed = false;

    container.append(app.canvas);
    app.canvas.classList.add('dancing-fractals__canvas');
    app.canvas.setAttribute('role', 'img');
    app.canvas.setAttribute('aria-label', 'Dancing Fractals animation');

    const centerX = app.screen.width / 2;
    const centerY = app.screen.height / 2;

    let currentFractal: FractalAnimation<any> | null = null;
    let currentConfig: any = null;
    let currentCtor: FractalAnimationConstructor<any> | null = null;

    let lifetimeSeconds: number | null = null;
    let remainingLifetime: number | null = null;

    let fps = 0;
    const fpsSmoothing = .01;

    const musicFeatureExtractor = createMusicFeatureExtractor();

    // Route-safety guard: if the URL path changes, the host is no longer active and should self-dispose.
    const onTick = (time: Ticker): void => {
        if (destroyed) return;

        if (window.location.pathname !== initialPathname) {
            dispose();
            destroyed = true;
            return;
        }

        // PIXI ticker reports timing in milliseconds; animations consume (deltaSeconds, nowMs).
        const deltaMs = time.deltaMS;
        const deltaSeconds = deltaMs / 1000;
        const nowMs = time.lastTime;

        if (deltaSeconds > 0) {
            const inst = 1 / deltaSeconds;
            fps = fps === 0 ? inst : fps + (inst - fps) * fpsSmoothing;
        }

        if (
            lifetimeSeconds !== null &&
            currentFractal &&
            remainingLifetime !== null &&
            remainingLifetime > 0
        ) {
            remainingLifetime = Math.max(0, remainingLifetime - deltaSeconds);
        }

        if (!currentFractal) return;

        const audioState = audioEngine.state;
        const musicFeatures = musicFeatureExtractor.step({
            deltaSeconds,
            nowMs,
            audioState,
        });

        currentFractal.step(deltaSeconds, nowMs, audioState, musicFeatures);
    };
    app.ticker.add(onTick);

    const applyLifetime = () => {
        if (!currentFractal) return;
        if (lifetimeSeconds == null) {
            remainingLifetime = null;
            return;
        }

        remainingLifetime = lifetimeSeconds;
        // `scheduleDisposal` delay is expressed in seconds.
        currentFractal.scheduleDisposal(lifetimeSeconds);
    };

    const setFractal = <C>(
        Fractal: FractalAnimationConstructor<C>,
        config: C
    ) => {
        if (currentFractal) {
            currentFractal.dispose();
            currentFractal = null;
        }

        currentCtor = Fractal as FractalAnimationConstructor<any>;
        currentConfig = config;

        musicFeatureExtractor.reset();

        (app.renderer as any).background.color = Fractal.backgroundColor;

        const fractal = new Fractal(centerX, centerY, config);
        fractal.init(app);
        
        currentFractal = fractal as FractalAnimation<any>;
        applyLifetime();
    };

    const updateConfig = <C>(patch: Partial<C>) => {
        if (!currentFractal || currentConfig == null) return;

        currentConfig = { ...currentConfig, ...patch };
        currentFractal.updateConfig(patch as any);
    };

    const restart = () => {
        if (!currentCtor || currentConfig == null) return;

        if (currentFractal) {
            currentFractal.dispose();
            currentFractal = null;
        }

        const Fractal = currentCtor;

        musicFeatureExtractor.reset();

        const fractal = new Fractal(centerX, centerY, currentConfig);
        fractal.init(app);
        
        currentFractal = fractal;
        applyLifetime();
    };

    const setLifetime = (seconds: number | null) => {
        lifetimeSeconds = seconds;
         if (!currentFractal) {
            remainingLifetime = seconds;
            return;
        }

        if (lifetimeSeconds == null) {
            remainingLifetime = null;
            return;
        }

        remainingLifetime = lifetimeSeconds;
        currentFractal.scheduleDisposal(lifetimeSeconds);
    };

    const getStats = () => ({
        fps,
        remainingLifetime,
    });

    const dispose = () => {
        if (destroyed) return;
        destroyed = true;

        if (currentFractal) {
            currentFractal.dispose();
            currentFractal = null;
        }
        
        app.ticker.remove(onTick);
        app.canvas.remove();
        app.destroy(true, { children: true, texture: true });
    };

    const host: FractalHost = {
        setFractal,
        updateConfig,
        restart,
        setLifetime,
        getStats,
        dispose,
    };

    return host;
}
