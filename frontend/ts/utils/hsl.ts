/**
 * HSL/HSLA utilities used by visuals and animations.
 *
 * Canonical representation in this project:
 * - Hue is expressed in **degrees**. Helpers that normalize hue wrap it into $[0, 360)$.
 * - Saturation and lightness are expressed as **percent** values (typically $[0, 100]$).
 * - Alpha is expressed as a **unit interval** value and is clamped to $[0, 1]$ when formatting HSLA.
 *
 * Conventions:
 * - `wrapHue` wraps degrees; it does not clamp saturation/lightness.
 * - `hslToRgb` converts to RGB byte channels for efficient pixel/uniform use.
 */
import { clamp } from "@/utils/clamp";
import { getRandomInt } from "@/utils/random";

/**
 * HSL color expressed as degrees and percents.
 *
 * @category Color — Support
 */
export type HslColor = {
	/** Hue angle in **degrees**. Helpers such as wrapHue normalize this into $[0, 360)$. */
	hue: number;
	/** Saturation in **percent** (typically $[0, 100]$). */
	saturation: number;
	/** Lightness in **percent** (typically $[0, 100]$). */
	lightness: number;
};

/**
 * Randomization ranges for generating HSL colors.
 *
 * All ranges are inclusive min/max tuples.
 * - `hue` is in **degrees** (wrapped by consumers if needed) and is optional by design.
 * - `saturation` and `lightness` are in **percent**.
 *
 * @category Color — Support
 */
export type HslRanges = {
	/** Optional hue range in **degrees**. If omitted, hue is chosen uniformly from $[0, 360)$. */
	hue?: readonly [number, number];
	/** Saturation range in **percent** (inclusive). */
	saturation: readonly [number, number];
	/** Lightness range in **percent** (inclusive). */
	lightness: readonly [number, number];
};

const formatHue = (h: number): string => {
	// Normalize first (keeps range stable), then round to avoid tiny float noise.
	const wrapped = wrapHue(Number.isFinite(h) ? h : 0);
	// 3 decimals is plenty for smooth lerp and prevents 1e-7 style output.
	const rounded = Math.round(wrapped * 1000) / 1000;
	// Ensure we never return "-0"
	const safe = Object.is(rounded, -0) ? 0 : rounded;

	// String(...) of this value will never be scientific notation now.
	return safe.toString();
};

/**
 * Formats an {@link HslColor} as a CSS `hsl(...)` string.
 *
 * Hue is wrapped into $[0, 360)$ and formatted as a non-scientific decimal.
 *
 * @returns A string in the form `hsl(<hue>, <saturation>%, <lightness>%)`.
 */
export function toHslString(color: HslColor) { return `hsl(${formatHue(color.hue)}, ${color.saturation}%, ${color.lightness}%)`; }

/**
 * Formats an {@link HslColor} + alpha as a CSS `hsla(...)` string.
 *
 * Alpha is clamped to $[0, 1]$ and formatted with 3 decimal places.
 *
 * @returns A string in the form `hsla(<hue>, <saturation>%, <lightness>%, <alpha>)`.
 */
export function toHslaString(color: HslColor, alpha: number) { 
	return `hsla(${formatHue(color.hue)}, ${color.saturation}%, ${color.lightness}%, ${clamp(alpha, 0, 1).toFixed(3)})`;
};
/**
 * Parses a CSS `hsl(...)` string into an {@link HslColor}.
 *
 * The parser is intentionally simple: it expects comma-separated components and reads integer
 * values (e.g. `"hsl(120, 50%, 40%)"`).
 */
export function parseHslString(hsl: string): HslColor {
    const rawHsl = hsl.slice(4, -1).split(",").map(string => string.trim());

    const hue = parseInt(rawHsl[0], 10);
    const saturation = parseInt(rawHsl[1], 10);
    const lightness = parseInt(rawHsl[2], 10);

    return { hue, saturation, lightness };
};

/**
 * Wraps a hue angle in degrees into the canonical range $[0, 360)$.
 */
export function wrapHue(h: number) { return ((h % 360) + 360) % 360; }

/** Shortest signed hue distance in degrees; exact half-turns retain their direction. */
export function signedHueDistance(from: number, to: number): number {
    let delta = wrapHue(to) - wrapHue(from);
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return delta;
}

const lerpHue = (h1: number, h2: number, t: number) => {
    return wrapHue(wrapHue(h1) + signedHueDistance(h1, h2) * t);
};

/**
 * Linearly interpolates between two HSL colors.
 *
 * Hue interpolation wraps through the shortest angular distance. Saturation/lightness are interpolated
 * linearly and rounded to integers.
 */
export function lerpHsl(a: HslColor, b: HslColor, t: number): HslColor {
    return {
        hue: lerpHue(a.hue, b.hue, t),
        saturation: Math.round(a.saturation + (b.saturation - a.saturation) * t),
        lightness: Math.round(a.lightness + (b.lightness - a.lightness) * t),
    };
}
/**
 * Converts an {@link HslColor} (degrees, percents) to RGB byte channels.
 *
	 * Hue is normalized via wrapHue. Saturation/lightness are clamped to $[0, 1]$ after
 * converting from percent.
 *
 * @returns `[r, g, b]` as integers in the range `[0, 255]`.
 */
export function hslToRgb(color: HslColor): [number, number, number] {
	const h = wrapHue(color.hue) / 360;
	const s = clamp(color.saturation / 100, 0, 1);
	const l = clamp(color.lightness / 100, 0, 1);

	const hue2rgb = (p: number, q: number, tt: number) => {
		let t = tt;
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};

	let r: number, g: number, b: number;

	if (s === 0) {
		r = g = b = l;
	} else {
		const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		r = hue2rgb(p, q, h + 1 / 3);
		g = hue2rgb(p, q, h);
		b = hue2rgb(p, q, h - 1 / 3);
	}

	return [
		Math.round(r * 255),
		Math.round(g * 255),
		Math.round(b * 255),
	];
};

const getRandomHue = (): number => (Math.random() * 360) | 0;

/**
 * Generates a random {@link HslColor} from the provided ranges.
 *
 * If `ranges.hue` is omitted, hue is chosen uniformly from `[0, 360)` degrees.
 */
export function getRandomHsl(ranges: HslRanges): HslColor {
	const hue = ranges?.hue
		? getRandomInt(ranges.hue[0], ranges.hue[1])
		: getRandomHue();

	const saturation = getRandomInt(ranges.saturation[0], ranges.saturation[1]);
	const lightness = getRandomInt(ranges.lightness[0], ranges.lightness[1]);

	return { hue, saturation, lightness };
};
