/**
 * FlowerSpiral fractal animation.
 *
 * High-level dataflow:
 * - Inputs: per-frame timing (`deltaSeconds`, `nowMs`), config patches via {@link FlowerSpiral.updateConfig},
 *   and optional music features ({@link MusicFeaturesFrame}).
 * - Outputs: draws a full-screen quad with a GLSL filter; per-frame state is expressed via shader uniforms.
 *
 * Ownership boundaries:
 * - This module owns the animation lifecycle and orchestration (state, config hot-updates, disposal).
 * - Shader/uniform wiring is delegated to `FlowerSpiralShader.ts`.
 */
import { Application, Filter, Sprite, Texture, UniformGroup } from "pixi.js";

import { PaletteTween } from "@/animations/helpers/color/PaletteTween";
import { PitchHueCommitter } from "@/animations/helpers/color/PitchHueCommitter";
import type { AudioState } from "@/animations/helpers/audio/AudioEngine";
import type { MusicFeaturesFrame } from "@/animations/helpers/music/MusicFeatureExtractor";
import { clamp } from "@/utils/clamp";
import type { FractalAnimation } from "../interfaces/FractalAnimation";
import { defaultFlowerSpiralConfig, type FlowerSpiralConfig } from "../config/FlowerSpiralConfig";
import { FLOWER_MAX, clampFlowerAmount, createFlowerSpiralFilter, createFlowerSpiralUniformGroup } from "./flower spiral/FlowerSpiralShader";

const PITCH_STABLE_THRESHOLD_MS = 120;
const MIN_MUSIC_WEIGHT_FOR_COLOR = 0.25;

/**
 * GPU-driven generative spiral "flowers" animation.
 *
 * Units & semantics:
 * - `deltaSeconds` is in **seconds**.
 * - `nowMs` is an absolute time in **milliseconds** and is also uploaded to the shader as `uTimeMs`.
 * - Pitch hue values are in **degrees** (from the pitch hue committer).
 *
 * @category Fractals — Core
 */
export class FlowerSpiral implements FractalAnimation<FlowerSpiralConfig> {
    constructor(
        private readonly centerX: number,
        private readonly centerY: number,
        initialConfig: Partial<FlowerSpiralConfig> = {},
    ) {
        this.config = { ...defaultFlowerSpiralConfig, ...initialConfig };

        this.paletteTween = new PaletteTween(this.config.palette, this.config.flowerAmount);

        this.pitchHueCommitter = new PitchHueCommitter(this.config.palette[0]?.hue ?? 0);
    }

    static disposalSeconds = 10;
    static backgroundColor: string = "rgb(199, 255, 229)";

    private config: FlowerSpiralConfig;

    private app: Application | null = null;

    // Fullscreen quad (single draw call) + GLSL filter.
    private mesh: Sprite | null = null;
    private filter: Filter | null = null;
    private uniformGroup: UniformGroup | null = null;
    private paletteHsl: Float32Array | null = null;

    private configDirty = true;
    private paletteDirty = true;

    // Visible flower count (float) for smooth appear/disappear.
    private visibleFlowerCount = 0;

    // PaletteTween state
    private paletteTween: PaletteTween;
    private colorChangeCounter = 0;
    private beatRetargetCooldownMs = 0;

    // Music beat impulse
    private beatKick01 = 0;

    // Pitch hue (degrees) derived from pitch class
    private pitchHueCommitter: PitchHueCommitter;

    // Disposal logic
    private disposalDelay = 0;
    private disposalTimer = 0;
    private autoDispose = false;
    private isDisposing = false;

    /**
     * Initializes PIXI resources and seeds shader uniforms.
     *
     * Call once before {@link FlowerSpiral.step}. Resources created here are released by
     * {@link FlowerSpiral.dispose}.
     */
    init(app: Application): void {
        this.app = app;

        const quad = Sprite.from(Texture.WHITE);
        this.mesh = quad;
        quad.position.set(0, 0);
        quad.width = app.screen.width;
        quad.height = app.screen.height;

        const { uniformGroup, paletteHsl } = createFlowerSpiralUniformGroup({
            widthPx: app.screen.width,
            heightPx: app.screen.height,
            centerX: this.centerX,
            centerY: this.centerY,
        });
        this.uniformGroup = uniformGroup;
        this.paletteHsl = paletteHsl;

        // Seed zoom in case the config disables animated zoom.
        (uniformGroup.uniforms as any).uZoom = 1.0;

        const filter = createFlowerSpiralFilter(uniformGroup);
        this.filter = filter;
        quad.filters = [filter];

        app.stage.addChild(quad);

        this.visibleFlowerCount = 0;
        this.beatKick01 = 0;

        this.pitchHueCommitter.reset(this.config.palette[0]?.hue ?? 0);

        this.configDirty = true;
        this.paletteDirty = true;
    }

    /**
     * Advances the animation by one frame.
     *
     * @param deltaSeconds - Elapsed time since the previous frame, in **seconds**.
     * @param nowMs - Absolute time in **milliseconds**.
     * @param _audioState - Raw audio engine state (unused; this animation consumes {@link MusicFeaturesFrame}).
     * @param musicFeatures - Feature frame used for beat/pitch-driven motion and palette bias.
     */
    step(deltaSeconds: number, nowMs: number, _audioState: AudioState, musicFeatures: MusicFeaturesFrame): void {
        const app = this.app;
        const quad = this.mesh;
        const uniformGroup = this.uniformGroup;
        const paletteHsl = this.paletteHsl;

        if (!app || !quad || !uniformGroup || !paletteHsl) return;

        const zoom = this.computeZoom(nowMs);

        if (this.autoDispose) {
            this.disposalTimer += deltaSeconds;
            if (this.disposalTimer >= this.disposalDelay) {
                this.startDisposal();
            }
        }

        quad.width = app.screen.width;
        quad.height = app.screen.height;

        // Audio-reactive behavior: gate by `hasMusic`, then apply beat/pitch-derived signals.
        const features = musicFeatures;
        const hasMusic = !!features?.hasMusic;
        const musicWeight01 = clamp(features?.musicWeight01 ?? 0, 0, 1);
        const beatEnv01 = clamp(features?.beatEnv01 ?? 0, 0, 1);
        const beatHit = !!features?.beatHit;
        const pitchHue = this.pitchHueCommitter.step({
            deltaSeconds,
            features,
            stableThresholdMs: PITCH_STABLE_THRESHOLD_MS,
            minMusicWeightForColor: MIN_MUSIC_WEIGHT_FOR_COLOR,
        }).pitchHueDeg;

        // Beat kick: a fast impulse with a fixed decay rate.
        const KICK_DECAY_PER_SEC = 6;
        if (hasMusic) {
            if (beatHit) {
                this.beatKick01 = 1;
            } else {
                this.beatKick01 = Math.max(0, this.beatKick01 - deltaSeconds * KICK_DECAY_PER_SEC);
            }
        } else {
            this.beatKick01 = 0;
        }

        this.updateVisibleFlowers(deltaSeconds);

        this.updatePaletteTween(deltaSeconds, hasMusic, beatHit);
        this.uploadPaletteUniforms(paletteHsl);

        if (this.configDirty) {
            this.uploadConfigUniforms(uniformGroup);
            this.configDirty = false;
        }

        this.uploadFrameAndMusicUniforms(uniformGroup, {
            nowMs,
            widthPx: app.screen.width,
            heightPx: app.screen.height,
            hasMusic,
            musicWeight01,
            beatEnv01,
            beatKick01: this.beatKick01,
            pitchHue,
            zoom,
            visibleFlowerCount: this.visibleFlowerCount,
        });
    }
    
    /**
     * Applies a shallow config patch.
     *
     * Merge semantics: `this.config` is replaced via `{ ...this.config, ...patch }`.
     * Palette-related changes rebuild the {@link PaletteTween} immediately and mark the palette upload dirty.
     */
    updateConfig(patch: Partial<FlowerSpiralConfig>): void {
        const prev = this.config;
        this.config = { ...this.config, ...patch };
        
        const paletteChanged = patch.palette != null && patch.palette !== prev.palette;
        const flowerAmountChanged = patch.flowerAmount != null && patch.flowerAmount !== prev.flowerAmount;
        
        if (paletteChanged || flowerAmountChanged) {
            this.paletteTween = new PaletteTween(this.config.palette, this.config.flowerAmount);
            this.colorChangeCounter = 0;
            this.beatRetargetCooldownMs = 0;
            this.paletteDirty = true;
        }
        
        this.configDirty = true;
    }
    
    /** Schedules disposal to begin after `seconds` (in **seconds**) of runtime. */
    scheduleDisposal(seconds: number): void {
        this.disposalDelay = seconds;
        this.disposalTimer = 0;
        this.autoDispose = true;
        this.isDisposing = false;
    }
    
    /** Cancels the countdown without changing an active flower fade-out. */
    cancelScheduledDisposal(): void {
        this.autoDispose = false;
        this.disposalDelay = 0;
        this.disposalTimer = 0;
    }

    /** Starts the disposal fade-out immediately (flower count decreases until it reaches zero). */
    startDisposal(): void {
        if (this.isDisposing) return;
        this.isDisposing = true;
    }
    
    /** Immediately releases PIXI resources owned by this instance. */
    dispose(): void {
        this.autoDispose = false;
        this.isDisposing = false;
        
        if (this.mesh) {
            this.mesh.removeFromParent();
            this.mesh.destroy({ children: true, texture: false, textureSource: false });
            this.mesh = null;
        }
        
        if (this.filter) {
            this.filter.destroy();
            this.filter = null;
        }
        
        this.uniformGroup = null;
        this.paletteHsl = null;
        
        this.app = null;
    }
    
    private computeZoom(nowMs: number): number {
        // Enabled-by-default: treat missing/undefined as enabled.
        if (this.config.zoomEnabled === false) return 1.0;

        const z0 = Number.isFinite(this.config.zoomMin) ? this.config.zoomMin : 1.0;
        const z1 = Number.isFinite(this.config.zoomMax) ? this.config.zoomMax : 1.0;
        const speed = Number.isFinite(this.config.zoomSpeed) ? this.config.zoomSpeed : 0.0;

        const TAU = Math.PI * 2;
        const tSec = nowMs * 0.001;
        const phase = tSec * speed * TAU;
        const w = 0.5 + 0.5 * Math.sin(phase);

        return z0 + (z1 - z0) * w;
    }

    private updateVisibleFlowers(deltaSeconds: number): void {
        const target = clampFlowerAmount(this.config.flowerAmount);
        const speed = this.config.flowersPerSecond;
        
        if (!this.isDisposing) {
            this.visibleFlowerCount += speed * deltaSeconds;
            if (this.visibleFlowerCount > target) this.visibleFlowerCount = target;
            return;
        }
        
        this.visibleFlowerCount -= speed * deltaSeconds;
        if (this.visibleFlowerCount <= 0) {
            this.visibleFlowerCount = 0;
            this.dispose();
        }
    }

    private updatePaletteTween(deltaSeconds: number, hasMusic: boolean, beatHit: boolean): void {
        this.colorChangeCounter += deltaSeconds;

        const deltaMs = deltaSeconds * 1000;
        this.beatRetargetCooldownMs = Math.max(0, this.beatRetargetCooldownMs - deltaMs);

        if (hasMusic && beatHit && this.beatRetargetCooldownMs <= 0) {
            this.paletteTween.retarget();
            this.beatRetargetCooldownMs = 120;
            this.colorChangeCounter = 0;
            this.paletteDirty = true;
        }

        if (!hasMusic && this.colorChangeCounter >= this.config.colorChangeInterval) {
            this.paletteTween.retarget();
            this.colorChangeCounter = 0;
            this.paletteDirty = true;
        }

        const safeInterval = Math.max(0.0001, this.config.colorChangeInterval);
        const t = clamp(this.colorChangeCounter / safeInterval, 0, 1);
        this.paletteTween.step(t);
        this.paletteDirty = true;
    }

    private uploadPaletteUniforms(paletteHsl: Float32Array): void {
        if (!this.paletteDirty) return;

        const n = clampFlowerAmount(this.config.flowerAmount);

        for (let i = 0; i < FLOWER_MAX; i++) {
            const base = i * 3;
            if (i < n) {
                const c = this.paletteTween.currentColors[i];
                paletteHsl[base + 0] = c.hue;
                paletteHsl[base + 1] = clamp(c.saturation / 100, 0, 1);
                paletteHsl[base + 2] = clamp(c.lightness / 100, 0, 1);
            } else {
                paletteHsl[base + 0] = 0;
                paletteHsl[base + 1] = 0;
                paletteHsl[base + 2] = 0;
            }
        }

        this.paletteDirty = false;
    }

    /**
     * Uploads config-derived uniforms.
     *
     * Central semantics (as consumed by the shader):
     * - Counts are uploaded as integers (e.g. `uPetalsPerFlower`).
     * - Pixel-space values (thickness/length) are uploaded as-is.
     * - Rotation speed is interpreted in radians per second (shader uses `uTimeMs * 0.001`).
     */
    private uploadConfigUniforms(uniformGroup: UniformGroup): void {
        const u = uniformGroup.uniforms as any;
        const cfg = this.config;

        u.uFlowerAmount = clampFlowerAmount(cfg.flowerAmount);
        u.uPetalsPerFlower = clamp(cfg.petalsPerFlower | 0, 1, 64);
        u.uFlowersPerSecond = cfg.flowersPerSecond;
        u.uFlowersAlpha = cfg.flowersAlpha;
        u.uPetalRotationSpeed = cfg.petalRotationSpeed;
        u.uMinRadiusScale = cfg.minRadiusScale;
        u.uMaxRadiusScale = cfg.maxRadiusScale;
        u.uSpiralIncrement = cfg.spiralIncrement;
        u.uRevolutions = cfg.revolutions;
        u.uScale = cfg.scale;

        u.uPetalThicknessBase = cfg.petalThicknessBase;
        u.uPetalThicknessVariation = cfg.petalThicknessVariation;
        u.uPetalThicknessSpeed = cfg.petalThicknessSpeed;
        u.uPetalLengthBase = cfg.petalLengthBase;
        u.uPetalLengthVariation = cfg.petalLengthVariation;
        u.uPetalLengthSpeed = cfg.petalLengthSpeed;
    }

    private uploadFrameAndMusicUniforms(
        uniformGroup: UniformGroup,
        args: {
            nowMs: number;
            widthPx: number;
            heightPx: number;
            hasMusic: boolean;
            musicWeight01: number;
            beatEnv01: number;
            beatKick01: number;
            pitchHue: number;
            zoom: number;
            visibleFlowerCount: number;
        },
    ): void {
        const u = uniformGroup.uniforms as any;

        u.uTimeMs = args.nowMs;

        u.uResolution[0] = args.widthPx;
        u.uResolution[1] = args.heightPx;

        u.uCenterPx[0] = this.centerX;
        u.uCenterPx[1] = this.centerY;

        u.uZoom = args.zoom;

        u.uHasMusic = args.hasMusic ? 1 : 0;
        u.uMusicWeight01 = args.musicWeight01;
        u.uBeatEnv01 = args.beatEnv01;
        u.uBeatKick01 = args.beatKick01;
        u.uPitchHue = args.pitchHue;

        u.uVisibleFlowerCount = args.visibleFlowerCount;
    }
}
