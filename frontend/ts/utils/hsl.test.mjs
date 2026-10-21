import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const server = await createViteTestServer({
    root: frontendRoot, configFile: `${frontendRoot}/vite.config.ts`,
    appType: 'custom', logLevel: 'silent', server: { middlewareMode: true },
});
after(() => server.close());
const { lerpHsl, signedHueDistance } = await server.ssrLoadModule('/ts/utils/hsl.ts');

const color = hue => ({ hue, saturation: 40, lightness: 60 });

test('the shared hue distance preserves wrapping, direction and half-turn ties', () => {
    for (const [from, to, expected] of [
        [350, 10, 20], [10, 350, -20], [0, 180, 180], [180, 0, -180],
        [270, 90, -180], [90, 270, 180], [-10, 370, 20], [720, -360, 0],
    ]) assert.equal(signedHueDistance(from, to), expected, `${from} to ${to}`);
});

test('hue interpolation takes the shortest path and preserves the direction of half-turn ties', () => {
    for (const [from, to, midpoint] of [
        [350, 10, 0], [10, 350, 0], [0, 180, 90], [180, 0, 90],
        [270, 90, 180], [90, 270, 180], [-10, 370, 0], [720, -360, 0],
    ]) {
        assert.equal(lerpHsl(color(from), color(to), .5).hue, midpoint, `${from} to ${to}`);
    }
});

test('HSL interpolation keeps endpoint wrapping, extrapolation and channel rounding', () => {
    const from = { hue: 350, saturation: 31, lightness: 46 };
    const to = { hue: 370, saturation: 64, lightness: 73 };
    assert.deepEqual(lerpHsl(from, to, 0), from);
    assert.deepEqual(lerpHsl(from, to, 1), { ...to, hue: 10 });
    assert.deepEqual(lerpHsl(from, to, .5), { hue: 0, saturation: 48, lightness: 60 });
    assert.deepEqual(lerpHsl(from, to, 2), { hue: 30, saturation: 97, lightness: 100 });
});

test('invalid hue values continue to propagate instead of inventing a fallback color', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
        assert.ok(Number.isNaN(lerpHsl(color(value), color(20), .5).hue));
        assert.ok(Number.isNaN(lerpHsl(color(20), color(value), .5).hue));
    }
});
