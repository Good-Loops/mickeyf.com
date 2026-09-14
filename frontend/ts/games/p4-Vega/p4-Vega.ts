/**
 * Composition root / game runner for the P4-Vega PIXI scene.
 *
 * Responsibilities:
 * - Bootstraps the PIXI renderer + root stage container and attaches the canvas to the provided DOM container.
 * - Creates and owns the lifetime of major game entities (e.g. `Sky`, `P4`, `Water`, `BlackHole`) and their PIXI resources.
 * - Wires the per-frame loop (update orchestration + render) and controls start/stop ordering.
 * - Publishes score/results to the React page and owns restart and submission lifetimes.
 *
 * Ownership boundaries:
 * - Entities encapsulate their internal state and per-entity PIXI objects; this module owns their creation, update order,
 *   and teardown/recreation during restart.
 * - The fixed 60Hz simulation preserves the original movement speeds independently of rendering frequency.
 */
// Register Pixi's CSP-safe generators before renderer creation in the native app.
import 'pixi.js/unsafe-eval';
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '@/utils/constants';
import { enableCanvasPageGestures } from '@/utils/canvasPageGestures';
import { getRandomInt } from '@/utils/random';
import { bindP4RestartTap } from './p4RestartTap';
import { bindP4Input } from './p4Input';
import { createP4RunResults, type P4RunResult } from './p4RunResult';
import { createP4SimulationClock } from './p4SimulationClock';
import { P4_WIN_SCORE } from './p4Rules';
import { resolveP4AssetUrl } from './p4AssetUrl';
import { PickupFeedback } from './classes/PickupFeedback';
import { createP4PauseController, type P4VegaController, type P4VegaState } from './p4PauseController';

export type { P4VegaController, P4VegaState } from './p4PauseController';

import { API_BASE } from '@/config/apiConfig';
import { apiFetch } from '@/services/apiFetch';

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

import { Context, Player } from 'tone';
import { 
    autoDetectRenderer, 
    Container, 
    Assets, 
    AnimatedSprite, 
    Spritesheet,
    Ticker 
} from 'pixi.js';

export type P4VegaOptions = {
    isAuthenticated?: () => boolean;
    onStateChange?: (state: P4VegaState) => void;
    onScoreChange?: (score: number) => void;
    onResultChange?: (result: P4RunResult | null) => void;
    signal?: AbortSignal;
};

/** Starts one owned game session; aborting initialization or disposing releases its resources. */
export async function p4Vega(
    container?: HTMLElement,
    options: P4VegaOptions = {},
): Promise<P4VegaController> {
    const abortError = (): DOMException => new DOMException('P4-Vega initialization was cancelled.', 'AbortError');
    if (options.signal?.aborted) throw abortError();
    options.onStateChange?.('loading');

    const renderer = await autoDetectRenderer({
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        backgroundColor: 0x0d0033,
    });
    if (options.signal?.aborted) {
        renderer.destroy(true);
        throw abortError();
    }

    const canvas = renderer.view.canvas as HTMLCanvasElement;
    canvas.className = 'p4-vega__canvas';
    canvas.id = 'p4-canvas';
    enableCanvasPageGestures(canvas, renderer.events);
    container?.appendChild(canvas);

    const stage = new Container();
    const ticker = new Ticker();
    const simulation = createP4SimulationClock();
    const lifetime = new AbortController();
    const audioContext = new Context();
    const rawAudioContext = audioContext.rawContext as AudioContext;
    const root = container?.closest('[data-p4-vega]') ?? document;
    const bgMusicCheckbox = root.querySelector<HTMLInputElement>('[data-bg-music-playing]');
    const notesPlayingCheckbox = root.querySelector<HTMLInputElement>('[data-musical-notes-playing]');

    let sky: Sky | undefined;
    let p4: P4 | undefined;
    let water: Water | undefined;
    let spritesheets: Spritesheet[] = [];
    let input: ReturnType<typeof bindP4Input> | undefined;
    let musicPlaying = false;
    let pickupFeedback: PickupFeedback | undefined;

    const session = createP4PauseController({
        ticker,
        animations: () => [
            ...(p4 ? [p4.p4Anim] : []),
            ...(water ? [water.waterAnim] : []),
            ...BlackHole.bHAnimArray,
        ],
        clearInput: () => input?.clear(),
        audio: {
            suspend: () => rawAudioContext.suspend(),
            resume: () => audioContext.resume(),
            setMuted: (muted) => { audioContext.destination.mute = muted; },
        },
        onStateChange: (state) => {
            simulation.reset();
            options.onStateChange?.(state);
        },
        onAudioError: (error) => console.warn('P4-Vega audio pause/resume failed; the game remains paused.', error),
    });

    const synchronizeBackgroundMusic = (): void => {
        if (session.disposed || !p4MusicPlayer.loaded) return;
        const shouldPlay = bgMusicCheckbox?.checked ?? false;
        if (shouldPlay === musicPlaying) return;
        if (shouldPlay) p4MusicPlayer.start();
        else p4MusicPlayer.stop();
        musicPlaying = shouldPlay;
    };

    const p4MusicPlayer = new Player({
        context: audioContext,
        url: bgMusicURL,
        loop: true,
        onload: synchronizeBackgroundMusic,
        onerror: (error) => {
            if (!session.disposed) console.warn('P4-Vega background music could not load.', error);
        },
    }).toDestination();

    const updateAudioPreference = (): void => {
        synchronizeBackgroundMusic();
        if ((session.state === 'running' || session.state === 'game-over' || session.state === 'completed')
            && (bgMusicCheckbox?.checked || notesPlayingCheckbox?.checked)) {
            void audioContext.resume().catch((error: unknown) => {
                if (!session.disposed) console.warn('P4-Vega audio could not start.', error);
            });
        }
    };
    bgMusicCheckbox?.addEventListener('change', updateAudioPreference);
    notesPlayingCheckbox?.addEventListener('change', updateAudioPreference);

    const destroyRun = (): void => {
        p4?.destroy();
        water?.destroy();
        BlackHole.destroy();
        p4 = undefined;
        water = undefined;
        sky = undefined;
        pickupFeedback = undefined;
        stage.removeChildren().forEach((child) => child.destroy({ children: true }));
        spritesheets.forEach((sheet) => sheet.destroy(false));
        spritesheets = [];
    };

    const ensureActive = (): void => {
        if (session.disposed || lifetime.signal.aborted) throw abortError();
    };

    const load = async (): Promise<void> => {
        options.onScoreChange?.(0);
        const loadTexture = (source: string) => Assets.load(resolveP4AssetUrl(source, document.baseURI));
        const [p4Base, waterBase, bhBlueBase, bhRedBase, bhYellowBase] = await Promise.all([
            loadTexture(p4PngURL),
            loadTexture(waterPngURL),
            loadTexture(bhBluePngURL),
            loadTexture(bhRedPngURL),
            loadTexture(bhYellowPngURL),
        ]);
        ensureActive();

        const p4Sheet = new Spritesheet(p4Base, p4Data);
        const waterSheet = new Spritesheet(waterBase, waterData);
        const blueSheet = new Spritesheet(bhBlueBase, bhBlueData);
        const redSheet = new Spritesheet(bhRedBase, bhRedData);
        const yellowSheet = new Spritesheet(bhYellowBase, bhYellowData);
        const loadedSheets = [p4Sheet, waterSheet, blueSheet, redSheet, yellowSheet];
        try {
            await Promise.all(loadedSheets.map((sheet) => sheet.parse()));
            ensureActive();
        } catch (error) {
            loadedSheets.forEach((sheet) => sheet.destroy(false));
            throw error;
        }
        spritesheets = loadedSheets;

        sky = new Sky(stage);
        const p4Anim = new AnimatedSprite(p4Sheet.animations.p4);
        const waterAnim = new AnimatedSprite(waterSheet.animations.water);
        const blackHoleFrames = [
            blueSheet.animations.bhBlue,
            redSheet.animations.bhRed,
            yellowSheet.animations.bhYellow,
        ];
        for (let index = 0; index < 100; index++) {
            BlackHole.bHAnimArray.push(new AnimatedSprite(blackHoleFrames[getRandomInt(0, 2)]));
        }
        p4 = new P4(stage, p4Anim);
        if (!BlackHole.spawn(stage, p4Anim)) throw new Error('Black hole animation pool is empty');
        water = new Water(stage, waterAnim, audioContext);
        pickupFeedback = new PickupFeedback(stage);
        synchronizeBackgroundMusic();
        session.completeLoad();
    };

    const submitScore = async (score: number, signal: AbortSignal): Promise<{ personalBest: boolean }> => {
        const response = await apiFetch(API_BASE + '/api/users', {
            method: 'POST',
            credentials: 'include',
            signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'submit_score', p4_score: score }),
        });
        if (!response.ok) throw new Error('HTTP error! status: ' + response.status);
        const data = await response.json();
        if (data?.success !== true || typeof data.personalBest !== 'boolean') throw new Error('Invalid score submission response');
        return { personalBest: data.personalBest };
    };

    const results = createP4RunResults({
        submit: submitScore,
        onChange: (result) => { if (!session.disposed) options.onResultChange?.(result); },
    });

    const finishRun = (endedPlayer: P4, completed = false): void => {
        session.endRun(completed);
        renderer.render(stage);
        void results.finish(completed ? 'completed' : 'defeat', endedPlayer.totalWater, options.isAuthenticated?.() ?? false);
        session.finishGameOver();
    };

    const step = (): boolean => {
        if (!session.canMove || !sky || !p4 || !water) return false;
        sky.update();
        p4.update(p4.p4Anim);
        pickupFeedback?.update();
        const pickupX = water.waterAnim.x + water.waterAnim.width / 2;
        const pickupY = water.waterAnim.y + water.waterAnim.height / 2;
        if (water.update(water.waterAnim, p4, notesPlayingCheckbox?.checked ?? false, stage)) {
            options.onScoreChange?.(p4.totalWater);
            pickupFeedback?.show(pickupX, pickupY);
            if (p4.totalWater >= P4_WIN_SCORE) { finishRun(p4, true); return false; }
        }
        let gameLive = true;
        BlackHole.bHArray.forEach((blackHole) => { gameLive = blackHole.update(p4!, gameLive); });
        if (!gameLive) finishRun(p4);
        return gameLive;
    };
    ticker.add((frame) => simulation.advance(frame.elapsedMS, step));
    ticker.add(() => {
        if (!session.disposed) renderer.render(stage);
    });

    const restart = async (): Promise<void> => {
        if (!session.beginRestart()) return;
        results.reset();
        destroyRun();
        p4MusicPlayer.stop();
        musicPlaying = false;
        try {
            await load();
        } catch (error) {
            if (!session.disposed) console.error('P4-Vega restart failed.', error);
        }
    };

    input = bindP4Input({
        keyboardTarget: document,
        joysticks: Array.from(root.querySelectorAll<HTMLElement>('[data-p4-joystick]')),
        movement: () => p4,
        canMove: () => session.canMove,
        canRestart: () => session.canRestart,
        restart: () => { void restart(); },
    });
    const disposeRestartTap = bindP4RestartTap(canvas, () => session.canRestart, () => { void restart(); });

    const dispose = (): void => {
        if (session.disposed) return;
        session.dispose();
        results.dispose();
        lifetime.abort();
        options.signal?.removeEventListener('abort', dispose);
        ticker.destroy();
        input?.dispose();
        disposeRestartTap();
        bgMusicCheckbox?.removeEventListener('change', updateAudioPreference);
        notesPlayingCheckbox?.removeEventListener('change', updateAudioPreference);
        p4MusicPlayer.dispose();
        destroyRun();
        stage.destroy();
        renderer.destroy(true);
        audioContext.dispose();
        canvas.remove();
    };
    options.signal?.addEventListener('abort', dispose, { once: true });

    try {
        ensureActive();
        await load();
    } catch (error) {
        dispose();
        throw error;
    }
    return { dispose, pause: session.pause, resume: session.resume, restart, retrySubmission: results.retry };
}
