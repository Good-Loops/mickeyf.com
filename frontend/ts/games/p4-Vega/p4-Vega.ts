/**
 * Composition root / game runner for the P4-Vega PIXI scene.
 *
 * Responsibilities:
 * - Bootstraps the PIXI renderer + root stage container and attaches the canvas to the provided DOM container.
 * - Creates and owns the lifetime of major game entities (e.g. `Sky`, `P4`, `Water`, `BlackHole`) and their PIXI resources.
 * - Wires the per-frame loop (update orchestration + render) and controls start/stop ordering.
 * - Orchestrates game-over handling and reset flow, delegating end-state UI to shared helpers (e.g. `gameOver`).
 *
 * Ownership boundaries:
 * - Entities encapsulate their internal state and per-entity PIXI objects; this module owns their creation, update order,
 *   and teardown/recreation during restart.
 * - Shared helpers (e.g. `../utils/gameOver`) encapsulate specific end-state behavior (texts/UI composition), while this
 *   module decides when to invoke them and owns adding/removing the returned display objects.
 */
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '@/utils/constants';
import { getRandomInt } from '@/utils/random';
import { gameOver } from './utils/gameOver';

import { API_BASE } from '@/config/apiConfig';

import { P4 } from './classes/P4';
import { Water } from './classes/Water';
import { BlackHole } from './classes/BlackHole';
import { Sky } from './classes/Sky';

import p4Data from './data/p4.json';
import waterData from './data/water.json';
import bhBlueData from './data/bhBlue.json';
import bhRedData from './data/bhRed.json';
import bhYellowData from './data/bhYellow.json';

import p4PngURL from '@/assets/sprites/p4Vega/p4.png';
import waterPngURL from '@/assets/sprites/p4Vega/water.png';
import bhBluePngURL from '@/assets/sprites/p4Vega/bhBlue.png';
import bhRedPngURL from '@/assets/sprites/p4Vega/bhRed.png';
import bhYellowPngURL from '@/assets/sprites/p4Vega/bhYellow.png';

import bgMusicURL from '@/assets/audio/bg-sound-p4.mp3';

import Swal from 'sweetalert2';
import { Player } from 'tone';
import { 
    autoDetectRenderer, 
    Container, 
    ContainerChild, 
    Assets, 
    AnimatedSprite, 
    Spritesheet,
    Ticker 
} from 'pixi.js';

type P4VegaAuth = {
  isAuthenticated?: () => boolean;
};

/**
 * Starts a P4-Vega game session.
 *
 * Intended call site: route enter / game start, where a DOM container is available for the PIXI canvas.
 *
 * Inputs:
 * - `container`: Optional DOM element that receives the renderer's canvas.
 * - `auth`: Optional auth context used to decide whether to submit scores on game-over.
 *
 * Output:
 * - Resolves to a disposer function that stops the frame loop, unregisters event listeners, removes the canvas from the
 *   DOM, and destroys owned PIXI/audio resources.
 *
 * Lifecycle notes:
 * - Renderer/stage and event listeners are created immediately.
 * - Asset loading and entity construction happen inside `load()` (invoked once on start and again on restart).
 */
export async function p4Vega(container?: HTMLElement, auth?: P4VegaAuth): Promise<() => void> {
    const renderer = await autoDetectRenderer({
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        backgroundColor: 0x0d0033,
    });

    const canvas = renderer.view.canvas as HTMLCanvasElement;
    canvas.className = 'p4-vega__canvas';
    canvas.id = 'p4-canvas';
    container?.appendChild(canvas);

    const stage = new Container();

    const bgMusicCheckbox = document.querySelector(
        '[data-bg-music-playing]'
    ) as HTMLInputElement;
    const p4MusicPlayer = new Player({
        url: bgMusicURL,
        loop: true,
    }).toDestination();

    /** Toggles background music on/off based on the UI checkbox state. */
    const toggleBackgroundMusic = (): void => {
        if (bgMusicCheckbox.checked) {
            p4MusicPlayer.start();
        } else {
            p4MusicPlayer.stop();
        }
    };

    const notesPlayingCheckbox = document.querySelector(
        '[data-musical-notes-playing]'
    ) as HTMLInputElement;
    let notesPlaying = false;

    /** Toggles whether gameplay may emit musical notes (read by `Water.update(...)`). */
    const toggleNotesPlaying = (): void => {
        notesPlaying = notesPlayingCheckbox.checked;
    };

    let gameLive: boolean,
        gameOverTexts: ContainerChild[] = [],
        sky: Sky,
        p4: P4,
        water: Water;

    /**
     * (Re)loads assets and constructs a fresh set of entities for a new run.
     *
     * Ownership: this runner owns the created entities and is responsible for destroying their PIXI resources on
     * restart/cleanup.
     */
    const load = async (): Promise<void> => {
        toggleBackgroundMusic();

        gameLive = true;

        sky = new Sky(stage);

        const [
            p4Base,
            waterBase,
            bhBlueBase,
            bhRedBase,
            bhYellowBase,
        ] = await Promise.all([
            Assets.load(p4PngURL),
            Assets.load(waterPngURL),
            Assets.load(bhBluePngURL),
            Assets.load(bhRedPngURL),
            Assets.load(bhYellowPngURL),
        ]);

        const p4Spritesheet = new Spritesheet(p4Base, p4Data);
        const waterSpritesheet = new Spritesheet(waterBase, waterData);
        const bhBlueSpritesheet = new Spritesheet(bhBlueBase, bhBlueData);
        const bhRedSpritesheet = new Spritesheet(bhRedBase, bhRedData);
        const bhYellowSpritesheet = new Spritesheet(bhYellowBase, bhYellowData);

        await Promise.all([
            p4Spritesheet.parse(),
            waterSpritesheet.parse(),
            bhBlueSpritesheet.parse(),
            bhRedSpritesheet.parse(),
            bhYellowSpritesheet.parse(),
        ]);


        const p4Anim = new AnimatedSprite(p4Spritesheet.animations.p4);
        const waterAnim = new AnimatedSprite(
            waterSpritesheet.animations.water
        );

        // Pre-create a pool of animated sprites for `BlackHole` instances to draw from.
        for (let blackHoleIndex = 0; blackHoleIndex < 100; blackHoleIndex++) {
            let bhAnim: AnimatedSprite;
            switch (getRandomInt(0, 2)) {
                case 0:
                    bhAnim = new AnimatedSprite(
                        bhBlueSpritesheet.animations.bhBlue
                    );
                    break;
                case 1:
                    bhAnim = new AnimatedSprite(
                        bhRedSpritesheet.animations.bhRed
                    );
                    break;
                case 2:
                    bhAnim = new AnimatedSprite(
                        bhYellowSpritesheet.animations.bhYellow
                    );
                    break;
            }
            BlackHole.bHAnimArray.push(bhAnim!);
        }
        if (!BlackHole.spawn(stage, p4Anim)) {
            throw new Error('Black hole animation pool is empty');
        }

        p4 = new P4(stage, p4Anim);
        water = new Water(stage, waterAnim);
    };

    /**
     * Per-frame orchestration step.
     *
     * Called once per tick by Pixi's `Ticker`.
     *
     * Time units: this runner does not pass a delta value to entities (the `Ticker` delta is ignored here), so entity
     * movement/timing is governed by their internal per-update logic.
     *
     * Ordering is explicit:
     * - Background first (`sky`), then player (`p4`), then interactions/collection (`water`), then hazards (`BlackHole`).
     * - When the run ends (`gameLive === false`), the ticker is stopped and game-over UI is produced via `gameOver(...)`.
     */
    const update = async (): Promise<void> => {
        sky.update();
        p4.update(p4.p4Anim);
        water.update(water.waterAnim, p4, notesPlaying, stage);
        for (let i = 0; i < BlackHole.bHArray.length; i++) {
            let blackHole = BlackHole.bHArray[i];
            gameLive = blackHole.update(p4, gameLive);
        }

        if (!gameLive) {
            ticker.stop();
            const isAuthenticated = auth?.isAuthenticated?.() ?? false;
            if (isAuthenticated) {
                await submitScore();
            }
            gameOverTexts = await gameOver(gameLive, p4);
            gameOverTexts.forEach((text) => stage.addChild(text));
            renderer.render(stage);
        }
    };

    /**
     * Per-frame render step.
     *
     * Called once per tick by Pixi's `Ticker`, after `update()` in this runner.
     */
    const render = async (): Promise<void> => {
        renderer.render(stage);
    };

    const ticker = new Ticker();
    /**
     * Frame loop registration.
     *
     * Pixi calls each registered callback once per frame; this runner keeps update and render as separate callbacks to
     * make ordering explicit.
     */
    ticker.add(update);
    ticker.add(render);

    await load();
    ticker.start();

    /**
     * Restarts the current session by tearing down the current entities and rebuilding a fresh run.
     *
     * Entities are not reused across restarts; this ensures state does not leak between runs.
     */
    const restart = async (): Promise<void> => {
        gameLive = true;

        p4.destroy();
        water.destroy();
        BlackHole.destroy();
        stage.removeChildren();

        p4MusicPlayer.stop();

        await load();
        ticker.start();
    };

    /**
     * Submits the player's score.
     *
     * Called only on game-over, and only when an authenticated session is indicated by `auth`.
     */
    const submitScore = async () => {
        const p4_score = p4.totalWater;

        await fetch(`${API_BASE}/api/users`, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                type: 'submit_score',
                p4_score: p4_score,
            }),
        })
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return response.json();
            })
            .then((data) => {
                if (data.error) {
                    console.error(data.error);
                }
                if (data.personalBest) {
                    Swal.fire({
                        title: 'Congratulations!',
                        text: 'You have broken a new personal record, check the leaderboard to see where you stand!',
                        icon: 'success',
                    });
                }
            })
            .catch((error) => console.error('Fetch error:', error));
    };

    /**
     * Keyboard input wiring.
     *
     * - Arrow keys toggle movement flags on the `P4` entity.
     * - Space triggers restart when the run is over.
     *
     * Cleanup invariant: listeners registered here must be removed by the disposer.
     */
    const handleKeydown = (key: Event): void => {
        const code = (<KeyboardEvent>key).code;
        if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Space'].includes(code)) return;
        key.preventDefault();
        switch (code) {
            case 'ArrowRight':
                p4.isMovingRight = true;
                break;
            case 'ArrowLeft':
                p4.isMovingLeft = true;
                break;
            case 'ArrowUp':
                p4.isMovingUp = true;
                break;
            case 'ArrowDown':
                p4.isMovingDown = true;
                break;
            case 'Space':
                if (!gameLive) restart();
                break;
            default:
                break;
        }
    };

    /** Complements `handleKeydown` by clearing movement flags on key release. */
    const handleKeyup = (key: Event): void => {
        const code = (<KeyboardEvent>key).code;
        if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(code)) return;
        key.preventDefault();
        switch (code) {
            case 'ArrowRight':
                p4.isMovingRight = false;
                break;
            case 'ArrowLeft':
                p4.isMovingLeft = false;
                break;
            case 'ArrowUp':
                p4.isMovingUp = false;
                break;
            case 'ArrowDown':
                p4.isMovingDown = false;
                break;
            default:
                break;
        }
    };

    const registeredListeners: Array<{
        element: Document | HTMLElement;
        event: string;
        handler: EventListener;
    }> = [];

    document.addEventListener("keydown", handleKeydown);
    registeredListeners.push({
        element: document,
        event: "keydown",
        handler: handleKeydown,
    });

    document.addEventListener("keyup", handleKeyup);
    registeredListeners.push({
        element: document,
        event: "keyup",
        handler: handleKeyup,
    });

    bgMusicCheckbox.addEventListener("change", toggleBackgroundMusic);
    registeredListeners.push({
        element: bgMusicCheckbox,
        event: "change",
        handler: toggleBackgroundMusic,
    });

    notesPlayingCheckbox.addEventListener("change", toggleNotesPlaying);
    registeredListeners.push({
        element: notesPlayingCheckbox,
        event: "change",
        handler: toggleNotesPlaying,
    });

    const attachJoystick = (joystick: HTMLElement): void => {
        const joystickThumb = joystick.querySelector<HTMLElement>('[data-p4-joystick-thumb]');
        if (!joystickThumb) return;
        let joystickPointerId: number | null = null;

        const resetJoystick = (): void => {
            p4.isMovingRight = false;
            p4.isMovingLeft = false;
            p4.isMovingUp = false;
            p4.isMovingDown = false;
            joystickThumb.style.transform = 'translate(0, 0)';
        };

        const updateJoystick = (event: PointerEvent): void => {
            if (event.pointerId !== joystickPointerId) return;
            event.preventDefault();

            const bounds = joystick.getBoundingClientRect();
            const radius = bounds.width * .32;
            const offsetX = event.clientX - (bounds.left + bounds.width * .5);
            const offsetY = event.clientY - (bounds.top + bounds.height * .5);
            const distance = Math.hypot(offsetX, offsetY);
            const scale = distance > radius ? radius / distance : 1;
            const x = offsetX * scale;
            const y = offsetY * scale;
            const threshold = radius * .22;

            joystickThumb.style.transform = `translate(${x}px, ${y}px)`;
            p4.isMovingLeft = x < -threshold;
            p4.isMovingRight = x > threshold;
            p4.isMovingUp = y < -threshold;
            p4.isMovingDown = y > threshold;
        };

        const startJoystick = (event: Event): void => {
            if (!(event instanceof PointerEvent)) return;
            joystickPointerId = event.pointerId;
            joystick.setPointerCapture(event.pointerId);
            updateJoystick(event);
        };

        const stopJoystick = (event: Event): void => {
            if (!(event instanceof PointerEvent) || event.pointerId !== joystickPointerId) return;
            event.preventDefault();
            joystickPointerId = null;
            resetJoystick();
        };

        joystick.addEventListener('pointerdown', startJoystick);
        registeredListeners.push({ element: joystick, event: 'pointerdown', handler: startJoystick });
        joystick.addEventListener('pointermove', updateJoystick as EventListener);
        registeredListeners.push({ element: joystick, event: 'pointermove', handler: updateJoystick as EventListener });
        ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((event) => {
            joystick.addEventListener(event, stopJoystick);
            registeredListeners.push({ element: joystick, event, handler: stopJoystick });
        });
    };

    container?.closest('[data-p4-vega]')
        ?.querySelectorAll<HTMLElement>('[data-p4-joystick]')
        .forEach(attachJoystick);

    const handleCanvasPointerUp = (): void => {
        if (!gameLive) void restart();
    };
    canvas.addEventListener('pointerup', handleCanvasPointerUp);
    registeredListeners.push({
        element: canvas,
        event: 'pointerup',
        handler: handleCanvasPointerUp,
    });

    return () => {
        /**
         * Disposes the game session.
         *
         * Guarantees:
         * - Stops the frame loop.
         * - Stops background audio.
         * - Destroys owned PIXI resources and removes the canvas from the DOM.
         * - Unregisters all event listeners registered by this runner.
         */
        ticker.stop();
        ticker.destroy();

        if (p4MusicPlayer) {
            p4MusicPlayer.stop();
        }

        p4?.destroy();
        water?.destroy();
        BlackHole.destroy();
        stage.removeChildren();
        renderer.destroy(true);

        canvas.remove();

        registeredListeners.forEach(({ element, event, handler }) => {
            element.removeEventListener(event, handler);
        });
    };
}
