/**
 * Procedural branching “Tree” animation.
 *
 * High-level dataflow:
 * - Inputs: per-frame timing (`deltaSeconds`, `nowMs`), config patches via {@link Tree.updateConfig},
 *   and music features (beat envelope/hits + pitch hue) for motion/color modulation.
 * - Outputs: draws line segments into PIXI {@link Graphics} layers (one per depth).
 *
 * Ownership boundaries:
 * - This module owns the Tree animation lifecycle and scene orchestration.
 * - Palette retargeting is delegated to {@link PaletteTween}.
 * - Smoothing/clamping and HSL utilities are delegated to `expSmoothing`, `clamp`, and `hsl` helpers.
 */
import { Application, Graphics } from "pixi.js";
import { FractalAnimation } from "../interfaces/FractalAnimation";
import { PaletteTween } from "../../helpers/color/PaletteTween";
import { TreeConfig, defaultTreeConfig } from "../config/TreeConfig";
import { clamp } from "@/utils/clamp";
import { expSmoothing } from "@/utils/expSmoothing";
import { HslColor, lerpHsl, toHslString, wrapHue } from "@/utils/hsl";
import type { AudioState } from "@/animations/helpers/audio/AudioEngine";
import type { MusicFeaturesFrame } from "@/animations/helpers/music/MusicFeatureExtractor";

const ROT_BOOST = 0.9;
const WIGGLE_BOOST = 1.2;
const SPIN_BOOST = 2.0;
const MUSIC_MOTION_RESPONSIVENESS = 6;

const ROTATION_SPEED_RANGE: readonly [number, number] = [0, 3];
const WIGGLE_AMPLITUDE_RANGE: readonly [number, number] = [0, 3];
const DEPTH_SPIN_RANGE: readonly [number, number] = [0, 6];

const DEPTH_HUE_STEP_DEG = 26;

/**
 * CPU-rendered tree/roots animation with music-reactive motion and color.
 *
 * Lifecycle contract:
 * - {@link Tree.init} allocates and attaches PIXI resources.
 * - {@link Tree.step} updates animation state and redraws all depth layers.
 * - {@link Tree.updateConfig} applies shallow config patches and (if needed) rebuilds depth layers.
 * - {@link Tree.scheduleDisposal}/{@link Tree.startDisposal}/{@link Tree.dispose} manage teardown.
 *
 * Ownership:
 * - Owns one {@link Graphics} per depth (`depthGraphics`). These are added to `app.stage` and destroyed on dispose.
 *
 * Invariants:
 * - When initialized, `depthGraphics.length === config.maxDepth + 1`.
 * - `baseConfig` tracks user settings used as the baseline for music-driven motion targets.
 *
 * @category Fractals — Core
 */
export class Tree implements FractalAnimation<TreeConfig> {
	constructor(
		private readonly centerX: number,
		centerY: number,
		initialConfig: Partial<TreeConfig> = {}
	) {
		this.centerY = centerY + 140; // lower the base a bit

		this.config = { ...defaultTreeConfig, ...initialConfig };
		this.baseConfig = { ...this.config };

		this.paletteTween = new PaletteTween(
			this.config.palette,
			this.config.maxDepth + 1
		);
	}

	// Class-wide disposal time
	static disposalSeconds = 30;

	static backgroundColor = "hsla(143, 100%, 80%, 1.00)";

	// PIXI / scene
	private app: Application | null = null;

	// One Graphics per depth level so we can color each depth differently
	private depthGraphics: Graphics[] = [];

	// Tree layout
	private readonly centerY: number;

	// Config object with all tunables
	private config: TreeConfig;

	private readonly baseConfig: TreeConfig;

	// Rotation
	private rotationAngle = 0;

	// Animation state
	private visibleFactor = 0; // 0 → invisible, 1 → full tree

	// Disposal logic
	private isDisposing = false;
	private autoDispose = false;
	private disposalDelay = 0;
	private disposalTimer = 0;

	private paletteTween: PaletteTween;

	private colorChangeCounter: number = 0;

	/**
	 * Initializes the tree within the given PIXI application.
	 *
	 * Allocates `Graphics` layers based on the current `config.maxDepth` and attaches them to `app.stage`.
	 */
	init = (app: Application): void => {
		this.app = app;

		this.depthGraphics = [];
		for (let d = 0; d <= this.config.maxDepth; d++) {
			const g = new Graphics();
			this.depthGraphics.push(g);
			this.app.stage.addChild(g);
		}
	};

	/**
	 * Advances the animation by one frame.
	 *
	 * @param deltaSeconds - Elapsed time since the previous frame, in **seconds**.
	 * @param nowMs - Absolute time in **milliseconds**.
	 * @param audioState - Raw audio engine state; used only to synthesize a fallback feature frame.
	 * @param musicFeatures - Beat/pitch features driving color and motion when available.
	 */
	step = (deltaSeconds: number, nowMs: number, audioState: AudioState, musicFeatures: MusicFeaturesFrame): void => {
		if (!this.app || this.depthGraphics.length === 0) return;

		// Auto-disposal is time-based in seconds.
		if (this.autoDispose) {
			this.disposalTimer += deltaSeconds;
			if (this.disposalTimer >= this.disposalDelay) {
				this.startDisposal();
			}
		}

		if (!this.isDisposing) {
			if (this.visibleFactor < 1) {
				this.visibleFactor = Math.min(
					1,
					this.visibleFactor + this.config.growSpeed * deltaSeconds
				);
			}
		} else {
			if (this.visibleFactor > 0) {
				this.visibleFactor = Math.max(
					0,
					this.visibleFactor - this.config.shrinkSpeed * deltaSeconds
				);
			} else {
				this.dispose();
				return;
			}
		}

		if (!musicFeatures) {
			musicFeatures = this.createFallbackMusicFeatures(deltaSeconds, nowMs, audioState);
		}

		// PaletteTween always advances; retargeting cadence depends on music/beat presence.
		this.updateColors(deltaSeconds, musicFeatures.hasMusic, musicFeatures.beatHit);

		/**
		 * Audio-reactive motion:
		 * - Uses `beatEnv01` (expected $[0,1]$) to bias rotation/wiggle/spin targets.
		 * - Uses exponential smoothing in milliseconds to avoid snapping.
		 */
		{
			const deltaMs = deltaSeconds * 1000;
			const alpha = expSmoothing(deltaMs, MUSIC_MOTION_RESPONSIVENESS);

			const treeTargets = {
				rotationSpeedTarget: this.baseConfig.rotationSpeed + musicFeatures.beatEnv01 * ROT_BOOST,
				wiggleAmplitudeTarget: this.baseConfig.wiggleAmplitude + musicFeatures.beatEnv01 * WIGGLE_BOOST,
				depthSpinFactorTarget: this.baseConfig.depthSpinFactor + musicFeatures.beatEnv01 * SPIN_BOOST,
			};

			this.config.rotationSpeed +=
				(treeTargets.rotationSpeedTarget - this.config.rotationSpeed) * alpha;
			this.config.wiggleAmplitude +=
				(treeTargets.wiggleAmplitudeTarget - this.config.wiggleAmplitude) * alpha;
			this.config.depthSpinFactor +=
				(treeTargets.depthSpinFactorTarget - this.config.depthSpinFactor) * alpha;

			this.config.rotationSpeed = clamp(this.config.rotationSpeed, ...ROTATION_SPEED_RANGE);
			this.config.wiggleAmplitude = clamp(this.config.wiggleAmplitude, ...WIGGLE_AMPLITUDE_RANGE);
			this.config.depthSpinFactor = clamp(this.config.depthSpinFactor, ...DEPTH_SPIN_RANGE);
		}

		for (const graphic of this.depthGraphics) {
			graphic.clear();
		}

		// Angle values in this module are radians; `rotationSpeed` is radians per second.
		this.rotationAngle += deltaSeconds * this.config.rotationSpeed;

		const spin = this.rotationAngle;
		const timePhase = nowMs * 0.003;

		// Tree model parameters (config → runtime), central reference:
		// - Angles are in radians; time is in seconds (`deltaSeconds`) and milliseconds (`nowMs`).
		// - Lengths/widths are in PIXI world units (screen pixels for the default setup).
		// - Complexity is primarily driven by `maxDepth` (binary branching) and `branchScale` (how quickly length decays).
		this.drawBranch(
			this.centerX,
			this.centerY,
			-Math.PI / 2, // straight up
			this.config.baseLength * this.visibleFactor, // grow in
			0,
			spin,
			timePhase
		);

		const rootLength = this.config.baseLength * this.config.rootScale * this.visibleFactor;

		this.drawBranch(
			this.centerX,
			this.centerY,
			Math.PI / 2, // straight down
			rootLength,
			0,
			-spin,
			timePhase
		);

		const midY = this.centerY - this.config.baseLength * 0.3 * this.visibleFactor;

		const sideLength = this.config.baseLength * this.config.sideScale * this.visibleFactor;

		this.drawBranch(
			this.centerX,
			midY,
			Math.PI, // angle: left
			sideLength,
			0,
			spin,
			timePhase
		);

		this.drawBranch(
			this.centerX,
			midY,
			0, // angle: right
			sideLength,
			0,
			spin,
			timePhase
		);

		const maxDepthSafe = Math.max(1, this.config.maxDepth);

		for (let depth = 0; depth <= this.config.maxDepth; depth++) {
			const graphic = this.depthGraphics[depth];
			if (!graphic) continue;

			const depthRatio01 = depth / maxDepthSafe;
			if (depthRatio01 > this.visibleFactor) continue; // not visible yet

			const paletteColor = this.paletteTween.currentColors[depth];

			const musicColor = this.getMusicColorForDepth({
				depth,
				depthRatio01,
				maxDepth: maxDepthSafe,
				pitchHue: musicFeatures.pitchColor.hue,
				beatEnv01: musicFeatures.beatEnv01,
			});

			const depthWeight01 = musicFeatures.musicWeight01 * (1 - depthRatio01 * 0.5);
			const finalColor = lerpHsl(paletteColor, musicColor, depthWeight01);

			const colorStr = toHslString(finalColor);

			const width =
				this.config.trunkWidthMin +
				(this.config.trunkWidthBase - this.config.trunkWidthMin) * (1 - depthRatio01);

			const alpha = 1 - depthRatio01 * 0.3; // slightly fade tips

			graphic.stroke({
				width,
				color: colorStr,
				alpha,
				cap: "round",
			});
		}
	};

	private createFallbackMusicFeatures(
		deltaSeconds: number,
		nowMs: number,
		audioState: AudioState
	): MusicFeaturesFrame {
		const deltaMs = deltaSeconds * 1000;
		const hasMusic = !!audioState.hasAudio && !!audioState.playing;

		const clarity01 = clamp(audioState.clarity, 0, 1);
		const musicWeight01 = hasMusic ? clamp((clarity01 - 0.3) / 0.7, 0, 1) : 0;

		const beatStrength01 = clamp(audioState.beat.strength, 0, 1);
		const beatEnv01 = audioState.beat.isBeat ? beatStrength01 : 0;

		return {
			nowMs,
			deltaMs,
			hasMusic,
			musicWeight01,
			isBeat: audioState.beat.isBeat,
			beatStrength01,
			beatEnv01,
			beatHit: audioState.beat.isBeat,
			moveGroup: 0,
			pitchHz: audioState.pitchHz,
			clarity01,
			pitchColor: { hue: 0, saturation: 85, lightness: 55 },
			pitchDecision: undefined,
		};
	}

	private getMusicColorForDepth(params: {
		depth: number;
		depthRatio01: number;
		maxDepth: number;
		pitchHue: number;
		beatEnv01: number;
	}): HslColor {
		const musicHue = wrapHue(params.pitchHue + params.depth * DEPTH_HUE_STEP_DEG);
		const musicSat = clamp(70 + params.beatEnv01 * 25, 0, 100);
		const musicLight = clamp(30 + params.beatEnv01 * 15 - params.depthRatio01 * 10, 0, 100);
		return { hue: musicHue, saturation: musicSat, lightness: musicLight };
	}

	// Performance note: this is a binary recursion; node count grows ~ $2^{\text{depth}}$.
	// Guards on `maxDepth` and minimum segment length keep the worst-case bounded.
	private drawBranch = (
		x: number,
		y: number,
		angle: number,
		length: number,
		depth: number,
		spin: number,
		timePhase: number
	): void => {
		if (depth > this.config.maxDepth || length < 2) return;

		// Only draw this depth if it's within the current "visible" portion
		const depthRatio01 = depth / this.config.maxDepth;
		if (depthRatio01 > this.visibleFactor) return;

		const TWO_PI = Math.PI * 2;
		let baseAngle = angle % TWO_PI;
		if (baseAngle <= -Math.PI) baseAngle += TWO_PI;
		else if (baseAngle > Math.PI) baseAngle -= TWO_PI;

		// Smooth 4-lobe field over angle: [-1, 1], continuous
		// 2 * baseAngle → four sectors around the circle
		const quadBlend = Math.sin(2 * baseAngle);

		// Optional: control how strong quadrant shaping is
		const quadrantStrength = 0.5; // try 0.5–1.5

		const depthSpinMultiplier = 0.3 + depthRatio01 * this.config.depthSpinFactor;

		const localSpin = spin * depthSpinMultiplier * quadBlend * quadrantStrength;

		let segmentLength = length;
		if (depth === 0) {
			segmentLength = length * this.config.trunkShrinkFactor; // shorter trunk / root stem
		}

		const wiggle =
			Math.sin(
				timePhase * (1 + depthRatio01 * this.config.wiggleFrequencyFactor) + depth * 0.5
			) *
			this.config.wiggleAmplitude *
			depthRatio01;

		const angleWithSpin = angle + localSpin + wiggle;

		const x2 = x + Math.cos(angleWithSpin) * segmentLength;
		const y2 = y + Math.sin(angleWithSpin) * segmentLength;

		const g = this.depthGraphics[depth];
		if (!g) return;

		g.moveTo(x, y);
		g.lineTo(x2, y2);

		const nextLength = length * this.config.branchScale;
		const spread = 0.3; // angle between branches

		// Left branch
		this.drawBranch(x2, y2, angle - spread, nextLength, depth + 1, spin, timePhase);

		// Right branch
		this.drawBranch(x2, y2, angle + spread, nextLength, depth + 1, spin, timePhase);
	};

	private updateColors = (deltaSeconds: number, hasMusic: boolean, beatHit: boolean): void => {
		this.colorChangeCounter += deltaSeconds;

		const interval = this.config.colorChangeInterval;

		const timeRetarget = !hasMusic && this.colorChangeCounter >= interval;
		const beatRetarget = beatHit;

		if (timeRetarget || beatRetarget) {
			this.paletteTween.retarget();
			this.colorChangeCounter = 0;
		}

		const colorTween01 = interval <= 0 ? 1 : clamp(this.colorChangeCounter / interval, 0, 1);
		this.paletteTween.step(colorTween01);
	};

	/**
	 * Applies a shallow config patch.
	 *
	 * Merge semantics: `this.config` is replaced via `{ ...this.config, ...patch }`.
	 *
	 * Explicit patches also update `baseConfig`, preserving untouched baseline values independently of beat boosts.
	 *
	 * If `maxDepth` changes while initialized, depth graphics and the palette tween are rebuilt.
	 */
	updateConfig = (patch: Partial<TreeConfig>): void => {
		const oldMaxDepth = this.config.maxDepth;
		this.config = { ...this.config, ...patch };
		Object.assign(this.baseConfig, patch);

		// If maxDepth changed, rebuild depth graphics & color interpolator
		if (patch.maxDepth !== undefined && this.app && this.config.maxDepth !== oldMaxDepth) {
			// Remove old graphics
			for (const g of this.depthGraphics) {
				if (g.parent) {
					g.parent.removeChild(g);
				}
				g.destroy();
			}
			this.depthGraphics = [];

			// Create new graphics per depth
			for (let d = 0; d <= this.config.maxDepth; d++) {
				const g = new Graphics();
				this.depthGraphics.push(g);
				this.app.stage.addChild(g);
			}

			// Rebuild color interpolator with new depth count
			this.paletteTween = new PaletteTween(this.config.palette, this.config.maxDepth + 1);
		}
	};

	/** Schedules an animated disposal to begin after `seconds` (in **seconds**) of runtime. */
	scheduleDisposal = (seconds: number): void => {
		this.disposalDelay = seconds;
		this.disposalTimer = 0;
		this.autoDispose = true;
		this.isDisposing = false;
	};

	/** Cancels the countdown without changing an active shrinking animation. */
	cancelScheduledDisposal = (): void => {
		this.autoDispose = false;
		this.disposalDelay = 0;
		this.disposalTimer = 0;
	};

	/** Begins the disposal process immediately (tree shrinks until invisible, then disposes). */
	startDisposal = (): void => {
		if (this.isDisposing) return;

		this.isDisposing = true;
		this.autoDispose = false;
	};

	/** Immediately disposes of the tree and its PIXI resources. */
	dispose = (): void => {
		this.autoDispose = false;
		this.isDisposing = false;

		if (this.app) {
			for (const g of this.depthGraphics) {
				if (g.parent) {
					g.parent.removeChild(g);
				}
				g.destroy();
			}
		}

		this.depthGraphics = [];
		this.app = null;
	};
}
