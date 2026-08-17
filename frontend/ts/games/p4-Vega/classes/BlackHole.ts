/**
 * P4-Vega: BlackHole entity.
 *
 * Represents a moving hazard that is spawned into the scene, bounces within the canvas bounds, and can end
 * the run on collision with the player.
 *
 * Ownership boundaries:
 * - Owns black-hole-specific behavior (placement away from the player, movement direction, bounds bouncing).
 * - Overall game orchestration (spawning cadence, game-over handling) lives in the main game loop; this class
 *   only returns a `gameLive` flag based on collision.
 */
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '@/utils/constants';
import {
    getRandomBoolean,
    getRandomInt,
    getRandomX,
    getRandomY,
} from '@/utils/random';
import { isColliding } from '@/utils/isColliding';

import { Entity } from '@/games/helpers/Entity';

import { P4 } from './P4';

import { Container, ContainerChild, AnimatedSprite } from 'pixi.js';

const MIN_DISTANCE = 250;
const VELOCITY_MIN = 1.5;
const VELOCITY_MAX = 4.5;

/**
 * Moving black hole hazard for P4-Vega.
 *
 * Coordinate space & units:
 * - Uses PIXI/canvas coordinates in **pixels**.
 * - Velocity components (`vX`, `vY`) are in pixels per update call.
 *
 * Invariants:
 * - Placement attempts to keep the black hole at least `MIN_DISTANCE` pixels away from the player's sprite.
 * - Movement is axis-aligned in the current implementation (only one of `vX`/`vY` is non-zero).
 */
export class BlackHole extends Entity<AnimatedSprite> {
    private vX = 0;
    private vY = 0;

    private static addedIndexes: number[] = [];

    static bHAnimArray: AnimatedSprite[] = [];
    static bHArray: BlackHole[] = [];

    private constructor(
        stage: Container<ContainerChild>,
        p4Anim: AnimatedSprite,
        blackHoleAnim: AnimatedSprite
    ) {
        super(blackHoleAnim);

        this.anim.y = getRandomY(this.anim.height);
        this.anim.x = getRandomX(this.anim.width);

        this.determineDirection();

        this.setPosition(p4Anim);

        stage.addChild(this.anim);

        BlackHole.bHArray.push(this);
    }

    /** Returns whether an unused animation remains in the shared spawn pool. */
    static hasSpawnCapacity(): boolean {
        return BlackHole.addedIndexes.length < BlackHole.bHAnimArray.length;
    }

    /**
     * Spawns a black hole from an unused animation, or returns `null` when the pool is exhausted.
     *
     * Selection is made from a finite list of unused indexes, so exhaustion cannot cause an unbounded retry loop.
     */
    static spawn(
        stage: Container<ContainerChild>,
        p4Anim: AnimatedSprite
    ): BlackHole | null {
        const unusedIndexes = BlackHole.bHAnimArray
            .map((_, index) => index)
            .filter((index) => !BlackHole.addedIndexes.includes(index));

        if (unusedIndexes.length === 0) return null;

        const unusedIndex = unusedIndexes[
            getRandomInt(0, unusedIndexes.length - 1)
        ];
        const blackHoleAnim = BlackHole.bHAnimArray[unusedIndex];

        if (!blackHoleAnim) return null;

        BlackHole.addedIndexes.push(unusedIndex);
        return new BlackHole(stage, p4Anim, blackHoleAnim);
    }

    /** Chooses an initial axis-aligned movement direction and speed (pixels per update call). */
    private determineDirection() {
        if (getRandomBoolean()) {
            this.vX = getRandomInt(VELOCITY_MIN, VELOCITY_MAX);
        } else {
            this.vY = getRandomInt(VELOCITY_MIN, VELOCITY_MAX);
        }
    }

    /**
     * Chooses a random position and retries until the black hole is sufficiently far from the player.
     *
     * Note: this is a recursive retry; callers rely on the canvas being large enough for `MIN_DISTANCE`.
     */
    private setPosition(p4Anim: AnimatedSprite) {
        this.anim.x = getRandomX(this.anim.width);
        this.anim.y = getRandomY(this.anim.height);

        if (
            Math.abs(this.anim.x - p4Anim.x) < MIN_DISTANCE &&
            Math.abs(this.anim.y - p4Anim.y) < MIN_DISTANCE
        ) {
            this.setPosition(p4Anim);
        }
    }

    /**
     * Per-frame update.
     *
     * Side effects:
     * - Checks collision with the player and flips `gameLive` to `false` when colliding.
     * - Advances position by the current velocity and bounces when the sprite bounds hit canvas edges.
     *
     * @returns The updated `gameLive` flag.
     */
    update(p4: P4, gameLive: boolean): boolean {
        if (isColliding(p4.p4Anim, this.anim)) {
            gameLive = false;
        }

        if (this.vX == 0) {
            this.anim.y += this.vY!;
        } else {
            this.anim.x += this.vX!;
        }

        const bhBounds = this.anim.getBounds();

        if (bhBounds.y + bhBounds.height > CANVAS_HEIGHT || bhBounds.y < 0) {
            this.vY! *= -1;
        }
        if (bhBounds.x + bhBounds.width > CANVAS_WIDTH || bhBounds.x < 0) {
            this.vX! *= -1;
        }

        return gameLive;
    }

    /**
     * Destroys the shared animation sprites and clears global registries.
     *
     * Ownership note: `bHAnimArray` entries are treated as globally owned resources.
     */
    static destroy(): void {
        for (let i = 0; i < BlackHole.bHAnimArray.length; i++) {
            BlackHole.bHAnimArray[i].destroy();
        }
        BlackHole.bHArray = [];
        BlackHole.bHAnimArray = [];
        BlackHole.addedIndexes = [];
    }
}
