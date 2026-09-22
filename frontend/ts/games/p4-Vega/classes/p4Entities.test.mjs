import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../../testSupport/createViteTestServer.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createViteTestServer({
    root, configFile: `${root}/vite.config.ts`, logLevel: 'silent',
    appType: 'custom', server: { middlewareMode: true },
    plugins: [{
        name: 'p4-note-selector-fixture', enforce: 'pre',
        resolveId(source) {
            if (/(?:^|\/)GameplayNoteSelector(?:\.ts)?$/.test(source)) return '\0p4-note-selector';
        },
        load(id) {
            if (id !== '\0p4-note-selector') return;
            return `export const selectors = [];
                export class GameplayNoteSelector {
                    notes = 0;
                    constructor() { selectors.push(this); }
                    playNote() { this.notes++; }
                    dispose() {}
                }`;
        },
    }],
});
after(() => server.close());
const { P4 } = await server.ssrLoadModule('/ts/games/p4-Vega/classes/P4.ts');
const { Water } = await server.ssrLoadModule('/ts/games/p4-Vega/classes/Water.ts');
const { BlackHole } = await server.ssrLoadModule('/ts/games/p4-Vega/classes/BlackHole.ts');
const { selectors } = await server.ssrLoadModule('/ts/games/helpers/GameplayNoteSelector.ts');
const { CANVAS_WIDTH, CANVAS_HEIGHT } = await server.ssrLoadModule('/ts/utils/constants.ts');

function sprite(t) {
    return {
        x: 0, y: 0, width: 40, height: 40, visible: true,
        play: t.mock.fn(), stop: t.mock.fn(), destroy: t.mock.fn(),
        getBounds() { return { x: this.x, y: this.y, width: this.width, height: this.height }; },
    };
}

function fixture(t) {
    const stage = { addChild: t.mock.fn() };
    const playerSprite = sprite(t);
    const waterSprite = sprite(t);
    const player = new P4(stage, playerSprite);
    const water = new Water(stage, waterSprite);
    t.after(() => { player.destroy(); water.destroy(); });
    return { stage, player, water, playerSprite, waterSprite, selector: selectors.at(-1) };
}

const position = sprite => [sprite.x, sprite.y];
const overlap = ({ playerSprite, waterSprite }) => Object.assign(waterSprite, { x: playerSprite.x, y: playerSprite.y });

test('player updates its own sprite with full diagonal and proportional joystick movement', t => {
    const first = fixture(t);
    const second = fixture(t);
    const original = position(second.playerSprite);
    first.player.isMovingRight = first.player.isMovingDown = true;
    first.player.update();
    assert.deepEqual(position(first.playerSprite), [original[0] + 8, original[1] + 8]);
    assert.deepEqual(position(second.playerSprite), original);
    first.player.isMovingRight = first.player.isMovingDown = false;
    first.player.joystickX = .5;
    first.player.joystickY = -.25;
    first.player.update();
    assert.deepEqual(position(first.playerSprite), [original[0] + 12, original[1] + 6]);
});

test('player clamps fractional movement at both canvas edges', t => {
    const { player, playerSprite } = fixture(t);
    Object.assign(playerSprite, { x: CANVAS_WIDTH - 40 - .25, y: .25 });
    player.joystickX = .5;
    player.joystickY = -.5;
    player.update();
    assert.deepEqual(position(playerSprite), [CANVAS_WIDTH - 40, 0]);
    Object.assign(playerSprite, { x: .25, y: CANVAS_HEIGHT - 40 - .25 });
    player.joystickX = -.5;
    player.joystickY = .5;
    player.update();
    assert.deepEqual(position(playerSprite), [0, CANVAS_HEIGHT - 40]);
});

test('a water miss leaves score, sound, hazards and placement untouched', t => {
    const { stage, player, water, waterSprite, selector } = fixture(t);
    const spawn = t.mock.method(BlackHole, 'spawn', () => null);
    const original = position(waterSprite);
    assert.equal(water.update(player, true, stage), false);
    assert.equal(player.totalWater, 0);
    assert.equal(selector.notes, 0);
    assert.equal(spawn.mock.callCount(), 0);
    assert.deepEqual(position(waterSprite), original);
});

test('a pickup awards ten points, optionally plays sound, spawns a hazard and moves only its water', t => {
    const spawn = t.mock.method(BlackHole, 'spawn', () => null);
    t.mock.method(Math, 'random', () => .5);
    const untouched = fixture(t);
    const original = position(untouched.waterSprite);
    for (const notesPlaying of [false, true]) {
        const f = fixture(t);
        overlap(f);
        assert.equal(f.water.update(f.player, notesPlaying, f.stage), true);
        assert.equal(f.player.totalWater, 10);
        assert.equal(f.selector.notes, Number(notesPlaying));
        assert.deepEqual(spawn.mock.calls.at(-1).arguments, [f.stage, f.playerSprite]);
        assert.notDeepEqual(position(f.waterSprite), position(f.playerSprite));
        assert.equal(f.waterSprite.visible, true);
    }
    assert.equal(spawn.mock.callCount(), 2);
    assert.deepEqual(position(untouched.waterSprite), original);
});

test('the final pickup stops and hides water without spawning again or awarding extra points', t => {
    const f = fixture(t);
    const spawn = t.mock.method(BlackHole, 'spawn', () => null);
    const random = t.mock.method(Math, 'random', () => .5);
    f.player.totalWater = 990;
    overlap(f);
    assert.equal(f.water.update(f.player, true, f.stage), true);
    assert.equal(f.waterSprite.visible, false);
    assert.equal(f.waterSprite.stop.mock.callCount(), 1);
    assert.equal(f.water.update(f.player, true, f.stage), false);
    assert.equal(f.player.totalWater, 1000);
    assert.equal(f.selector.notes, 1);
    assert.equal(spawn.mock.callCount(), 0);
    assert.equal(random.mock.callCount(), 0);
});
