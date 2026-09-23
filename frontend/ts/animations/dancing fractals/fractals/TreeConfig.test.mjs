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
const { Tree } = await server.ssrLoadModule('/ts/animations/dancing fractals/fractals/Tree.ts');
const { defaultTreeConfig } = await server.ssrLoadModule('/ts/animations/dancing fractals/config/TreeConfig.ts');

const quietFeatures = {
    hasMusic: false, musicWeight01: 0, beatEnv01: 0, beatHit: false,
    pitchColor: { hue: 0, saturation: 85, lightness: 55 },
};

function createTree(config = {}) {
    const tree = new Tree(0, 0, config);
    // Run the real frame update with inert graphics; these tests do not verify GPU rendering.
    tree.app = {};
    tree.visibleFactor = 1;
    tree.depthGraphics = Array.from({ length: tree.config.maxDepth + 1 }, () => ({
        clear() {}, moveTo() {}, lineTo() {}, stroke() {},
    }));
    return tree;
}

test('setting Tree rotation to zero keeps subsequent quiet frames stationary', () => {
    const tree = createTree();
    tree.step(0.1, 100, {}, quietFeatures);
    const angle = tree.rotationAngle;

    tree.updateConfig({ rotationSpeed: 0 });
    for (let frame = 2; frame <= 20; frame++) {
        tree.step(0.1, frame * 100, {}, quietFeatures);
    }

    assert.equal(tree.rotationAngle, angle);
});

test('resetting a custom Tree restores its default motion baseline', () => {
    const tree = createTree({ rotationSpeed: 2, wiggleAmplitude: 1.5, depthSpinFactor: 4 });
    tree.updateConfig(defaultTreeConfig);

    for (let frame = 1; frame <= 20; frame++) {
        const previousAngle = tree.rotationAngle;
        tree.step(0.1, frame * 100, {}, quietFeatures);
        assert.ok(Math.abs(tree.rotationAngle - previousAngle - defaultTreeConfig.rotationSpeed * 0.1) < 1e-12);
        assert.equal(tree.config.wiggleAmplitude, defaultTreeConfig.wiggleAmplitude);
        assert.equal(tree.config.depthSpinFactor, defaultTreeConfig.depthSpinFactor);
    }
});

test('unrelated Tree patches do not preserve temporary beat boosts as defaults', () => {
    const tree = createTree();
    const motionFields = ['rotationSpeed', 'wiggleAmplitude', 'depthSpinFactor'];
    tree.step(0.1, 100, {}, { ...quietFeatures, hasMusic: true, beatEnv01: 1 });
    for (const field of motionFields) assert.ok(tree.config[field] > defaultTreeConfig[field]);

    tree.updateConfig({ branchScale: 0.8 });
    for (let frame = 2; frame <= 40; frame++) {
        tree.step(0.1, frame * 100, {}, quietFeatures);
    }

    for (const field of motionFields) {
        assert.ok(Math.abs(tree.config[field] - defaultTreeConfig[field]) < 1e-8, field);
    }
});
