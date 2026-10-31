/**
 * P4-Vega: P4 player entity.
 *
 * Represents the controllable player character for the P4-Vega game. This class owns per-player state
 * (movement intent flags, collected water count) and mutates its PIXI sprite each frame.
 *
 * Ownership boundaries:
 * - Owns the player sprite instance passed in (`p4Anim`) and manages its position updates.
 * - Game orchestration (spawning, input wiring, win/lose rules) lives outside this class (e.g. the game runner).
 */
import { AnimatedSprite, Container, ContainerChild } from 'pixi.js';
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '@/utils/constants';
import { Entity } from '@/games/helpers/Entity';
import { getP4MovementAxis } from '../p4Rules';

/**
 * Controllable player entity for P4-Vega.
 *
 * Coordinate space & units:
 * - Uses canvas/PIXI coordinates in **pixels**; `x/y` are top-left sprite coordinates.
 * - Movement uses a fixed per-update step (`speed` in pixels per update call).
 *
 * Lifecycle:
 * - Constructed with a stage/container and a pre-created animated sprite.
 * - Updated each frame via {@link update}.
 * - Cleaned up via {@link destroy} (destroys the sprite).
 *
 * Invariants:
 * - Enforces on-canvas bounds: keeps the sprite fully within `[0, CANVAS_WIDTH] x [0, CANVAS_HEIGHT]`.
 *
 * @category Games — Core
 */
export class P4 extends Entity<AnimatedSprite> {
    private startX = Entity.gap;
    private startY = CANVAS_HEIGHT * 0.5;

    /** Movement step per update call, in pixels. */
    private speed = 8;

    /** Gameplay counter for collected water (unitless count). */
    totalWater = 0;

    isMovingRight = false;
    isMovingLeft = false;
    isMovingUp = false;
    isMovingDown = false;

    joystickX = 0;
    joystickY = 0;

    /**
     * @param stage - Container that will own the sprite in the scene graph.
     * @param p4Anim - Player sprite owned and mutated by this entity.
     */
    constructor(
        stage: Container<ContainerChild>,
        public p4Anim: AnimatedSprite
    ) {
        super(p4Anim);
        stage.addChild(p4Anim);

        p4Anim.x = this.startX;
        p4Anim.y = this.startY;
    }

    /**
     * Per-frame update.
     *
     * Side effects:
     * - Mutates `p4Anim.x/y` based on movement flags.
     * - Combines keyboard and proportional joystick movement without normalizing diagonals.
     * - Clamps the sprite on-screen, including fractional movement near an edge.
     */
    update(): void {
        const { p4Anim } = this;
        const x = getP4MovementAxis(this.isMovingRight, this.isMovingLeft, this.joystickX);
        const y = getP4MovementAxis(this.isMovingDown, this.isMovingUp, this.joystickY);
        p4Anim.x = Math.max(0, Math.min(Math.max(0, CANVAS_WIDTH - p4Anim.width), p4Anim.x + x * this.speed));
        p4Anim.y = Math.max(0, Math.min(Math.max(0, CANVAS_HEIGHT - p4Anim.height), p4Anim.y + y * this.speed));
    }

    /** Destroys the player sprite. Caller is responsible for removing it from the stage if needed. */
    destroy() {
        this.p4Anim.destroy();
    }
}
