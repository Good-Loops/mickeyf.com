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
const { createMusicFeatureExtractor } = await server.ssrLoadModule(
    '/ts/animations/helpers/music/createMusicFeatureExtractor.ts',
);

for (const inactiveState of [
    { name: 'paused playback', hasAudio: true, playing: false },
    { name: 'unavailable audio', hasAudio: false, playing: true },
]) {
    test(`${inactiveState.name} lets the envelope decay without replaying the last beat`, () => {
        const extractor = createMusicFeatureExtractor();
        const audioState = {
            hasAudio: true, playing: true, pitchHz: 440, clarity: 1,
            volumeDb: -10, durationSec: 200, beat: { isBeat: true, strength: 1 },
        };
        let nowMs = 0;
        const step = () => extractor.step({ deltaSeconds: .02, nowMs: nowMs += 20, audioState });
        const initial = step();
        assert.equal(initial.beatHit, true);
        assert.ok(initial.beatEnv01 > 0);

        Object.assign(audioState, { hasAudio: inactiveState.hasAudio, playing: inactiveState.playing });
        let previousEnvelope = initial.beatEnv01;
        for (let i = 0; i < 100; i++) {
            const frame = step();
            assert.equal(frame.hasMusic, false);
            assert.equal(frame.beatHit, false, 'a retained beat snapshot must not retrigger');
            assert.equal(frame.moveGroup, initial.moveGroup);
            assert.ok(frame.beatEnv01 > 0 && frame.beatEnv01 < previousEnvelope,
                'the existing envelope decays smoothly instead of resetting');
            previousEnvelope = frame.beatEnv01;
        }
        assert.ok(previousEnvelope < .00001);

        Object.assign(audioState, { hasAudio: true, playing: true });
        const resumed = step();
        assert.equal(resumed.beatHit, true);
        assert.notEqual(resumed.moveGroup, initial.moveGroup);
    });
}
