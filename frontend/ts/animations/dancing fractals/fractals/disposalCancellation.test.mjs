import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../../testSupport/createViteTestServer.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createViteTestServer({
    root, configFile: `${root}/vite.config.ts`, logLevel: 'silent',
    appType: 'custom', server: { middlewareMode: true },
});
after(() => server.close());

// Exercise real lifecycle methods without allocating PIXI resources. Private state
// represents elapsed frames here; these checks do not claim to verify rendering.
const cases = [
    { name: 'Tree', progressField: 'visibleFactor', progress: 0.6 },
    { name: 'FlowerSpiral', progressField: 'visibleFlowerCount', progress: 4 },
    { name: 'Mandelbrot', progressField: 'disposalElapsed', progress: 2.75 },
];
const fractals = await Promise.all(cases.map(async entry => {
    const module = await server.ssrLoadModule(
        `/ts/animations/dancing fractals/fractals/${entry.name}.ts`,
    );
    return { ...entry, Fractal: module[entry.name] };
}));

function assertPendingDelay(fractal, name, seconds) {
    if (name === 'Mandelbrot') {
        assert.equal(fractal.disposalDelaySeconds, seconds);
    } else {
        assert.equal(fractal.autoDispose, seconds > 0);
        assert.equal(fractal.disposalDelay, seconds);
        assert.equal(fractal.disposalTimer, 0);
    }
}

for (const { name, progressField, progress, Fractal } of fractals) {
    test(`${name}: cancellation clears a pending delay and allows a fresh schedule`, () => {
        const fractal = new Fractal(0, 0);
        fractal.scheduleDisposal(30);
        if (name === 'Mandelbrot') fractal.disposalDelaySeconds = 18;
        else fractal.disposalTimer = 12;

        fractal.cancelScheduledDisposal();
        assertPendingDelay(fractal, name, 0);
        assert.equal(fractal.isDisposing, false);

        fractal.cancelScheduledDisposal();
        assertPendingDelay(fractal, name, 0);
        assert.equal(fractal.isDisposing, false);

        fractal.scheduleDisposal(9);
        assertPendingDelay(fractal, name, 9);
        assert.equal(fractal.isDisposing, false);
    });

    test(`${name}: cancellation preserves an already-started disposal transition`, () => {
        const fractal = new Fractal(0, 0);
        fractal.scheduleDisposal(30);
        fractal.startDisposal();
        fractal[progressField] = progress;

        for (let attempt = 0; attempt < 2; attempt++) {
            fractal.cancelScheduledDisposal();
            assertPendingDelay(fractal, name, 0);
            assert.equal(fractal.isDisposing, true);
            assert.equal(fractal[progressField], progress);
        }
    });
}
