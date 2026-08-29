/**
 * Game-over UI composition helper.
 *
 * Purpose:
 * - Encapsulates creation of end-state PIXI display objects (overlay text + background) for game runners.
 *
 * What this module provides:
 * - A helper that triggers a font load (via `webfontloader`) and resolves with display objects the caller may add to a
 *   PIXI stage/container.
 *
 * Ownership boundaries:
 * - This module allocates PIXI objects but does not attach them to a stage and does not retain references.
 * - The game runner owns overall lifecycle (stop/update loop, reset/restart) and decides when to call this helper and
 *   when/how to remove and destroy any returned display objects.
 */
import { Text, Graphics, ContainerChild } from 'pixi.js';

import { CANVAS_HEIGHT, CANVAS_WIDTH } from '@/utils/constants';

import { P4 } from '../classes/P4'

import WebFont from 'webfontloader';

/** Creates a centered `Text` in canvas pixel space using the Space Grotesk font. */
const centeredSpaceGrotesk = (text: string, fontSize: number, fill: number, yPositionOffset: number): Text => {
    const newText = new Text({
        text: text,
        style: {
            fontFamily: 'Space Grotesk',
            fontSize: fontSize,
            fill: fill,
            align: 'center'
        }
    });
    newText.position.set(CANVAS_WIDTH * .5 - newText.width / 2, CANVAS_HEIGHT * .5 - newText.height / 2 + yPositionOffset);
    return newText;
}

/**
 * Creates a rounded-rect background sized to enclose a set of text objects.
 *
 * All values are in canvas pixels; the returned `Graphics` is not added to a container here.
 */
const createBackgroundForText = (texts: Text[], padding: number, color: number, alpha: number, borderRadius: number): Graphics => {
    const minY = Math.min(...texts.map(text => text.y - padding));
    const maxY = Math.max(...texts.map(text => text.y + text.height + padding));
    const height = maxY - minY;
    const width = Math.max(...texts.map(text => text.width)) + 2 * padding;
    const x = CANVAS_WIDTH * .5 - width / 2;

    const background = new Graphics();
    background.fill({ color, alpha });
    background.roundRect(x, minY, width, height, borderRadius);
    background.fill();
    return background;
}

/**
 * Produces display objects for an end-state overlay.
 *
 * Intended call site: a game runner that has detected a run-ending condition.
 *
 * Parameters:
 * - `gameLive`: Runner-owned flag indicating whether the run is active. As implemented, this helper only resolves when
 *   `gameLive === false`.
 * - `p4`: Score source for display (`p4.totalWater`). This function reads from the instance but does not mutate it.
 *
 * Side effects:
 * - Initiates a font load via `WebFont.load(...)` and resolves only after the font becomes active.
 * - Allocates `Text` and `Graphics` objects but does not add them to a stage.
 *
 * Cleanup:
 * - This module does not register event listeners or timers.
 * - The caller owns removing/destroying any returned display objects when appropriate.
 *
 * Return value:
 * - A promise resolving to display objects (background first) for the caller to add to the stage.
 * - Note: if called with `gameLive === true`, the promise does not resolve (by construction).
 */
export function gameOver(gameLive: boolean, p4: P4): Promise<ContainerChild[]> {
    return new Promise((resolve) => {
        if (!gameLive) {
            WebFont.load({
                google: {
                    families: ['Space Grotesk']
                },
                active: () => {
                    const gameOverText = centeredSpaceGrotesk('GAME OVER', 63, 0xC80000, -20);
                    const totalWaterText = centeredSpaceGrotesk(`Total Water:  ${p4.totalWater}`, 40, 0xFFFFFF, 50);
                    const retryText = centeredSpaceGrotesk('Press space or tap to try again', 40, 0xFFFFFF, 100);
                    const texts = [gameOverText, totalWaterText, retryText];
                    const background = createBackgroundForText(texts, 10, 0xFFFFFF, 0.5, 10);

                    resolve([background, ...texts]);
                }
            });
        }
    });
}
