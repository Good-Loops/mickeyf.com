/**
 * P4-Vega: Water entity.
 *
 * Represents a collectible/interactive object that triggers an effect on collision with the player.
 * Participates in the game loop via {@link Water.update} and is rendered via a PIXI {@link AnimatedSprite}.
 *
 * Ownership boundaries:
 * - Owns water-specific state/behavior (sprite placement, note triggering, interaction handling).
 * - Game orchestration (spawning, scoring rules beyond the local increment) lives in the game loop.
 */
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '@/utils/constants';
import { getRandomX, getRandomY } from '@/utils/random';
import { areP4BoundsColliding, getP4PickupResult } from '../p4Rules';

import { GameplayNoteSelector } from '@/games/helpers/GameplayNoteSelector';
import { Entity } from '@/games/helpers/Entity';

import { BlackHole } from './BlackHole';
import { P4 } from './P4';

import { Container, ContainerChild, AnimatedSprite } from 'pixi.js';
import type { Context } from 'tone';

/**
 * Water entity for P4-Vega.
 *
 * Coordinate space & units:
 * - Uses PIXI/canvas coordinates in **pixels**.
 *
 * Ownership:
 * - Owns the `waterAnim` sprite reference and a private NoteSelector instance.
 * - Sprite is added to the provided stage in the constructor and destroyed in {@link destroy}.
 */
export class Water extends Entity<AnimatedSprite> {
    private startX = CANVAS_WIDTH - Entity.gap;
    private startY = CANVAS_HEIGHT * .5;
    private collectibleEnabled = true;

    private noteSelector: GameplayNoteSelector;

    /**
     * @param stage - Container that will own the water sprite in the scene graph.
     * @param waterAnim - Water sprite owned and mutated by this entity.
     */
    constructor(
        stage: Container<ContainerChild>,
        public waterAnim: AnimatedSprite,
        audioContext?: Context,
    ) {
        super(waterAnim);
        this.noteSelector = new GameplayNoteSelector(audioContext);
        stage.addChild(waterAnim);

        waterAnim.x = this.startX - waterAnim.width;
        waterAnim.y = this.startY;
    }

    /**
     * Per-frame update.
     *
     * Interaction contract:
     * - If `p4` collides with `waterAnim`, this method may:
     *   - play a note (when `notesPlaying` is true),
     *   - spawn a {@link BlackHole} effect,
     *   - reposition this water sprite to a new random location,
     *   - increment `p4.totalWater`.
     */
    update(
        p4: P4,
        notesPlaying: boolean,
        stage: Container<ContainerChild>
    ): boolean {
        const { waterAnim } = this;
        if (!this.collectibleEnabled || !areP4BoundsColliding(p4.p4Anim.getBounds(), waterAnim.getBounds())) return false;
        const pickup = getP4PickupResult(p4.totalWater);
        if (!pickup) return false;

        p4.totalWater = pickup.score;
        if (notesPlaying) this.noteSelector.playNote();

        if (pickup.completed) {
            // The initial hazard plus 99 pickup hazards uses the pool; pickup 100 ends the run.
            this.disableCollectible();
        } else {
            BlackHole.spawn(stage, p4.p4Anim);
            waterAnim.x = getRandomX(waterAnim.width + Entity.gap);
            waterAnim.y = getRandomY(waterAnim.height + Entity.gap);
        }
        return true;
    }

    /** The final collectible disappears only after its points have been awarded. */
    private disableCollectible(): void {
        this.collectibleEnabled = false;
        this.waterAnim.visible = false;
        this.waterAnim.stop();
    }

    /** Destroys the water sprite. Caller is responsible for removing it from the stage if needed. */
    destroy() {
        this.noteSelector.dispose();
        this.waterAnim.destroy();
    }
}
