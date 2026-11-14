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
const { PitchHysteresis } = await server.ssrLoadModule('/ts/animations/helpers/audio/PitchHysteresis.ts');
const { PitchColorPolicy } = await server.ssrLoadModule('/ts/animations/helpers/audio/PitchColorPolicy.ts');
const { PitchColorPhaseController } = await server.ssrLoadModule('/ts/animations/helpers/audio/PitchColorPhaseController.ts');
const idle = { hue: 120, saturation: 20, lightness: 30 };
const aColor = { hue: 270, saturation: 85, lightness: 55 };

function fixture(noteStep = true) {
    const tracker = new PitchHysteresis({
        minClarity: .8, minHz: 20, holdAfterSilenceMs: 100,
        minStableMs: 40, minHoldMs: 40, smoothingBase: 1,
        smoothingClarityScale: 0, microSemitoneRange: .65, deadbandFrac: .5,
    });
    const policy = new PitchColorPolicy({ tracker, tuning: {
        noteStep, microHueDriftDeg: 8, pitchSaturation: 85, pitchLightness: 55,
        silenceRanges: { hue: [120, 120], saturation: [20, 20], lightness: [30, 30] },
    } });
    let nowMs = 0;
    const decide = (pitchHz, dtMs = 50) => policy.decide({ pitchHz, clarity: 1, dtMs, nowMs: nowMs += dtMs });
    return { policy, tracker, decide };
}

test('same-note recovery restores the pitch color after idle without inventing a pitch change', () => {
    const { policy, decide } = fixture();
    assert.deepEqual(decide(440).color, aColor);
    for (let cycle = 0; cycle < 2; cycle++) {
        assert.deepEqual(decide(0, 50).color, aColor, 'brief silence holds pitch color');
        assert.deepEqual(decide(0, 50).color, idle, 'sustained silence chooses idle color');
        const resumed = decide(440);
        assert.deepEqual(resumed.color, aColor);
        assert.equal(resumed.result.changed, false);
        assert.deepEqual(policy.lastGoodColor, aColor);
    }
});

test('note-step mode preserves its exact committed color until a different pitch stabilizes', () => {
    const { decide } = fixture();
    decide(440);
    assert.deepEqual(decide(445).color, aColor, 'in-note drift does not change the committed color');
    decide(0, 100);
    const pending = decide(493.88);
    assert.equal(pending.result.changed, false);
    assert.deepEqual(pending.color, aColor, 'uncommitted candidate retains the previous pitch color');
    const committed = decide(493.88);
    assert.equal(committed.result.changed, true);
    assert.equal(committed.result.pitchClass, 11);
    assert.ok(Math.abs(committed.color.hue - 330) < .01);
    decide(0, 100);
    assert.deepEqual(decide(493.88).color, committed.color);
});

test('silence before any pitch still gives way to the first valid pitch', () => {
    const { decide } = fixture();
    assert.deepEqual(decide(0, 100).color, idle);
    const firstPitch = decide(440);
    assert.deepEqual(firstPitch.color, aColor);
    assert.equal(firstPitch.result.changed, true);
});

test('continuous mode keeps micro drift and recomputes pitch color after silence', () => {
    const { decide } = fixture(false);
    decide(440);
    const drifted = decide(445);
    assert.ok(drifted.color.hue > 270 && drifted.color.hue <= 278);
    decide(0, 100);
    assert.deepEqual(decide(445).color, drifted.color);
});

function phaseFixture({ colorIntervalMs = 0, deltaMs = 50 } = {}) {
    const { policy, tracker } = fixture();
    const phase = new PitchColorPhaseController({ policy, tuning: {
        colorIntervalMs, listenAfterSilenceMs: 100, noteStep: true,
        commit: { holdMs: 0, smoothingResponsiveness: 12 },
        holdDrift: { deg: 0, hz: .2 },
        stableDrift: { rampMs: 0, hz: .2, hueDeg: 0, satDeg: 0, lightDeg: 0 },
    } });
    let nowMs = 0;
    const step = pitchHz => phase.step({ pitchHz, clarity: 1, deltaMs, nowMs: nowMs += deltaMs });
    return { policy, tracker, phase, step };
}

test('phase sampling counts each frame once toward the silence threshold', () => {
    const { step } = phaseFixture({ colorIntervalMs: 40, deltaMs: 10 });
    for (let i = 0; i < 3; i++) assert.equal(step(0).decision, undefined);

    const sampled = step(0);
    assert.equal(sampled.decision.result.silenceMs, 40);
    assert.notDeepEqual(sampled.decision.color, idle, '40 ms must not satisfy 100 ms of silence');
});

test('phase sampling does not commit a new note before its stability duration', () => {
    const { tracker, step } = phaseFixture({ colorIntervalMs: 40, deltaMs: 10 });
    step(440);
    step(440); // Leave the intentional post-commit hold phase.
    step(493.88); // Start tracking the new candidate.
    for (let i = 0; i < 3; i++) {
        step(493.88);
        assert.equal(tracker.committedPitchClass, 9, 'the new note has not been stable for 40 ms');
    }

    const committed = step(493.88);
    assert.equal(committed.decision.result.changed, true);
    assert.equal(tracker.committedPitchClass, 11);
});

test('phase reset after same-note recovery uses pitch color, not the stale idle color', () => {
    const { phase, step } = phaseFixture();
    assert.deepEqual(step(440).color, aColor);
    step(440); // Leave the intentional post-commit hold phase.
    for (let i = 0; i < 3; i++) assert.deepEqual(step(0).color, aColor);
    const resumed = step(440);
    assert.equal(resumed.decision.result.changed, false);
    assert.deepEqual(resumed.color, aColor, 'continuous rendering already retained the pitch anchor');
    phase.reset();
    assert.deepEqual(step(440).color, aColor, 'reset must not seed rendering from the old idle decision');
});

test('phase reset during silence restores the musical anchor when the same note returns', () => {
    const { policy, phase, step } = phaseFixture();
    step(440);
    step(440); // Leave the intentional post-commit hold phase.
    for (let i = 0; i < 3; i++) step(0);
    assert.deepEqual(policy.lastGoodColor, idle);

    phase.reset();
    assert.deepEqual(step(0).color, idle);
    step(0); // Leave the idle anchor's hold phase before sampling pitch again.
    const resumed = step(440);
    assert.equal(resumed.decision.result.changed, false, 'the tracker still remembers this note');
    assert.deepEqual(resumed.decision.color, aColor);
    assert.notDeepEqual(resumed.color, idle, 'rendering must leave the idle anchor');
    assert.notDeepEqual(resumed.color, aColor, 'recovery must preserve the smooth transition');
    let settled = resumed;
    for (let i = 0; i < 20; i++) settled = step(440);
    assert.ok(Math.abs(settled.color.hue - aColor.hue) < .1);
    // Existing HSL interpolation rounds these channels to whole percentages.
    assert.ok(Math.abs(settled.color.saturation - aColor.saturation) <= 1);
    assert.ok(Math.abs(settled.color.lightness - aColor.lightness) <= 1);
});
