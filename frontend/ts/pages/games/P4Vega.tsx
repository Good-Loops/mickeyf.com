/**
 * p4-Vega game page ("/games/p4-Vega").
 * Mounts the PIXI game runner and provides the page-level UI controls.
 * Unmount must dispose the runner to stop the loop and release resources.
 */
import React, { useEffect, useRef, useState } from "react";
import { useAuth } from '@/context/AuthContext';
import { p4Vega, type P4VegaController, type P4VegaState } from '@/games/p4-Vega/p4-Vega';
import FullscreenButton from "@/components/FullscreenButton";
import ScoreSubmissionNotice from '@/components/ScoreSubmissionNotice';
import Dropdown from '@/components/Dropdown';
import P4VegaHelp from './P4VegaHelp';
import P4VegaResults from './P4VegaResults';
import type { P4RunResult } from '@/games/p4-Vega/p4RunResult';

type JoystickSide = 'left' | 'right';

const JOYSTICK_SIDE_STORAGE_KEY = 'p4-vega-fullscreen-joystick-side';

const PlaybackIcon: React.FC<{ paused: boolean }> = ({ paused }) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        {paused
            ? <path d="m9 5 11 7-11 7Z" fill="currentColor" />
            : <path d="M8 5v14M16 5v14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />}
    </svg>
);

const P4Vega: React.FC = () => {
    const canvasWrapperRef = useRef<HTMLDivElement | null>(null);
    const controllerRef = useRef<P4VegaController | null>(null);
    const pauseButtonRef = useRef<HTMLButtonElement | null>(null);
    const resumeButtonRef = useRef<HTMLButtonElement | null>(null);
    const helpDialogRef = useRef<HTMLDialogElement | null>(null);
    const previousStateRef = useRef<P4VegaState>('loading');
    const [gameState, setGameState] = useState<P4VegaState>('loading');
    const [gameError, setGameError] = useState(false);
    const [score, setScore] = useState(0);
    const [result, setResult] = useState<P4RunResult | null>(null);
    const { isAuthenticated, loading } = useAuth();
    const isAuthenticatedRef = useRef(isAuthenticated);

    isAuthenticatedRef.current = isAuthenticated;

    const [selectedKey, setSelectedKey] = useState<string>('C');
    const [selectedScale, setSelectedScale] = useState<string>('Major');
    const showSubmissionNotice = !loading && !isAuthenticated;
    const paused = gameState === 'paused';
    const canTogglePause = gameState === 'running' || paused;
    const [joystickSide, setJoystickSide] = useState<JoystickSide>(() => {
        if (typeof window === 'undefined') return 'right';
        const savedSide = window.localStorage.getItem(JOYSTICK_SIDE_STORAGE_KEY);
        return savedSide === 'left' ? 'left' : 'right';
    });

    const selectJoystickSide = (side: JoystickSide): void => {
        setJoystickSide(side);
        window.localStorage.setItem(JOYSTICK_SIDE_STORAGE_KEY, side);
    };

    useEffect(() => {
        if (loading || !canvasWrapperRef.current) return;

        const abortController = new AbortController();
        const container = canvasWrapperRef.current;
        setGameState('loading');
        setGameError(false);
        setScore(0);
        setResult(null);

        (async () => {
            try {
                const controller = await p4Vega(container, {
                    isAuthenticated: () => isAuthenticatedRef.current,
                    signal: abortController.signal,
                    onStateChange: (state) => {
                        if (!abortController.signal.aborted) setGameState(state);
                    },
                    onScoreChange: (value) => {
                        if (!abortController.signal.aborted) setScore(value);
                    },
                    onResultChange: (value) => {
                        if (!abortController.signal.aborted) setResult(value);
                    },
                    onLoadError: () => {
                        if (!abortController.signal.aborted) setGameError(true);
                    },
                });
                if (abortController.signal.aborted) controller.dispose();
                else controllerRef.current = controller;
            } catch (error) {
                if (!abortController.signal.aborted) {
                    console.error('Unable to load p4-Vega:', error);
                    setGameError(true);
                }
            }
        })();

        return () => {
            abortController.abort();
            controllerRef.current?.dispose();
            controllerRef.current = null;
        };
    }, [loading]);

    useEffect(() => {
        if (!helpDialogRef.current?.open) {
            if (paused) resumeButtonRef.current?.focus({ preventScroll: true });
            else if (previousStateRef.current === 'paused') {
                pauseButtonRef.current?.focus({ preventScroll: true });
            }
        }
        previousStateRef.current = gameState;
    }, [gameState, paused]);

    const togglePause = (): void => {
        const controller = controllerRef.current;
        if (!controller || !canTogglePause) return;
        if (paused) void controller.resume();
        else void controller.pause();
    };

    const openHelp = (): void => {
        // Also cancel an in-flight Resume before it can restart play under the guide.
        void controllerRef.current?.pause();
        helpDialogRef.current?.showModal();
        helpDialogRef.current?.querySelector('.p4-vega__help-body')?.scrollTo(0, 0);
    };

    return (
        <section
            className={`p4-vega${showSubmissionNotice ? ' p4-vega--submission-notice' : ''}`}
            data-p4-vega
            data-joystick-side={joystickSide}
        >
            <h1 className='u-visually-hidden'>p4-Vega</h1>
            <ScoreSubmissionNotice
                isAuthenticated={isAuthenticated}
                loading={loading}
            />

            <div
                className="p4-vega__canvas-wrapper"
                ref={canvasWrapperRef}
                data-game-state={gameState}
            >
                <div className="p4-vega__score" aria-label={`Score: ${score}`}>
                    <span>Score</span><strong>{score.toLocaleString()}</strong>
                </div>
                <FullscreenButton
                    targetRef={canvasWrapperRef}
                    className="p4-vega__fullscreen-btn"
                />
                <button
                    type="button"
                    ref={pauseButtonRef}
                    className="p4-vega__pause-btn"
                    onClick={togglePause}
                    disabled={!canTogglePause}
                    aria-label={paused ? 'Resume game' : 'Pause game'}
                    aria-expanded={paused}
                    aria-controls={paused ? 'p4-pause-menu' : undefined}
                    title={paused ? 'Resume game' : 'Pause game'}
                >
                    <PlaybackIcon paused={paused} />
                </button>
                {paused && (
                    <div className="p4-vega__pause-overlay">
                        <div
                            id="p4-pause-menu"
                            className="p4-vega__pause-menu"
                            role="dialog"
                            aria-labelledby="p4-pause-heading"
                        >
                            <span className="p4-vega__pause-eyebrow">p4-Vega</span>
                            <h2 id="p4-pause-heading">Paused</h2>
                            <button
                                type="button"
                                ref={resumeButtonRef}
                                className="p4-vega__resume-btn"
                                onClick={togglePause}
                            >
                                <PlaybackIcon paused />
                                Resume
                            </button>
                            <button type="button" className="p4-vega__help-btn" onClick={openHelp} aria-haspopup="dialog">
                                How to play
                            </button>
                        </div>
                    </div>
                )}
                {result && (
                    <P4VegaResults
                        result={result}
                        onRestart={() => { void controllerRef.current?.restart(); }}
                        onRetrySubmission={() => { void controllerRef.current?.retrySubmission(); }}
                        onHelp={openHelp}
                        fullscreenTargetRef={canvasWrapperRef}
                        helpDialogRef={helpDialogRef}
                    />
                )}
                {gameError && <p className="p4-vega__load-error" role="alert">The game could not load. Please refresh to try again.</p>}
                <button
                    type="button"
                    className="p4-vega__joystick p4-vega__joystick--fullscreen"
                    data-p4-joystick
                    aria-label="Movement joystick"
                    disabled={gameState !== 'running'}
                >
                    <span className="p4-vega__joystick-thumb" data-p4-joystick-thumb />
                </button>
                <P4VegaHelp dialogRef={helpDialogRef} />
            </div>

            <div className='p4-vega__ui'>
                <button type="button" className="p4-vega__help-btn" onClick={openHelp} disabled={gameState === 'loading'} aria-haspopup="dialog">
                    How to play
                </button>
                <label className='p4-vega__ui--option' data-checkbox>
                    <input className='p4-vega__ui--checkbox' type='checkbox' data-bg-music-playing />
                    <span className='p4-vega__ui--option-btn'>Background Music</span>
                </label>
                <label className='p4-vega__ui--option' data-checkbox>
                    <input className='p4-vega__ui--checkbox' type='checkbox' data-musical-notes-playing />
                    <span className='p4-vega__ui--option-btn'>Notes Playing</span>
                </label>
                <div className='p4-vega__ui--dropdown-grid'>
                    <Dropdown
                        options={[
                            { value: 'C', label: 'C' },
                            { value: 'C#/Db', label: 'C#/Db' },
                            { value: 'D', label: 'D' },
                            { value: 'D#/Eb', label: 'D#/Eb' },
                            { value: 'E', label: 'E' },
                            { value: 'F', label: 'F' },
                            { value: 'F#/Gb', label: 'F#/Gb' },
                            { value: 'G', label: 'G' },
                            { value: 'G#/Ab', label: 'G#/Ab' },
                            { value: 'A', label: 'A' },
                            { value: 'A#/Bb', label: 'A#/Bb' },
                            { value: 'B', label: 'B' },
                        ]}
                        value={selectedKey}
                        onChange={setSelectedKey}
                        className="p4-vega__ui--dropdown"
                        buttonClassName="p4-vega__ui--dropdown-btn"
                        menuClassName="p4-vega__ui--dropdown-menu p4-vega__ui--dropdown-menu-keys"
                        optionClassName="p4-vega__ui--dropdown-menu-item"
                        renderSelected={(selected, fallbackLabel) => (
                            <>
                                Key:&nbsp;
                                <span className='u-truncate' data-selected-key>
                                    {selected?.label ?? fallbackLabel}
                                </span>
                            </>
                        )}
                    />
                    <Dropdown
                        options={[
                            { value: 'Major', label: 'Major' },
                            { value: 'Minor', label: 'Minor' },
                            { value: 'Pentatonic', label: 'Pentatonic' },
                            { value: 'Blues', label: 'Blues' },
                            { value: 'Dorian', label: 'Dorian' },
                            { value: 'Mixolydian', label: 'Mixolydian' },
                            { value: 'Phrygian', label: 'Phrygian' },
                            { value: 'Lydian', label: 'Lydian' },
                            { value: 'Locrian', label: 'Locrian' },
                            { value: 'Chromatic', label: 'Chromatic' },
                            { value: 'Harmonic Major', label: 'Harmonic Major' },
                            { value: 'Melodic Minor', label: 'Melodic Minor' },
                            { value: 'Whole Tone', label: 'Whole Tone' },
                            { value: 'Hungarian Minor', label: 'Hungarian Minor' },
                            { value: 'Double Harmonic', label: 'Double Harmonic' },
                            { value: 'Neapolitan Major', label: 'Neapolitan Major' },
                            { value: 'Neapolitan Minor', label: 'Neapolitan Minor' },
                            { value: 'Augmented', label: 'Augmented' },
                            { value: 'Hexatonic', label: 'Hexatonic' },
                            { value: 'Enigmatic', label: 'Enigmatic' },
                            { value: 'Spanish Gypsy', label: 'Spanish Gypsy' },
                            { value: 'Hirajoshi', label: 'Hirajoshi' },
                            { value: 'Balinese Pelog', label: 'Balinese Pelog' },
                            { value: 'Egyptian', label: 'Egyptian' },
                            { value: 'Hungarian Gypsy', label: 'Hungarian Gypsy' },
                            { value: 'Persian', label: 'Persian' },
                            { value: 'Tritone', label: 'Tritone' },
                            { value: 'Flamenco', label: 'Flamenco' },
                            { value: 'Iwato', label: 'Iwato' },
                            { value: 'Blues Heptatonic', label: 'Blues Heptatonic' },
                        ]}
                        value={selectedScale}
                        onChange={setSelectedScale}
                        className="p4-vega__ui--dropdown"
                        buttonClassName="p4-vega__ui--dropdown-btn"
                        menuClassName="p4-vega__ui--dropdown-menu"
                        optionClassName="p4-vega__ui--dropdown-menu-item"
                        renderSelected={(selected, fallbackLabel) => (
                            <>
                                Scale:&nbsp;
                                <span className='u-truncate' data-selected-scale>
                                    {selected?.label ?? fallbackLabel}
                                </span>
                            </>
                        )}
                    />
                </div>
            </div>

            <button
                type="button"
                className="p4-vega__joystick p4-vega__joystick--page"
                data-p4-joystick
                aria-label="Movement joystick"
                disabled={gameState !== 'running'}
            >
                <span className="p4-vega__joystick-thumb" data-p4-joystick-thumb />
            </button>

            <div className="p4-vega__joystick-preference" role="group" aria-label="Fullscreen joystick side">
                <span>Fullscreen joystick</span>
                <button
                    type="button"
                    aria-pressed={joystickSide === 'left'}
                    onClick={() => selectJoystickSide('left')}
                >
                    Left
                </button>
                <button
                    type="button"
                    aria-pressed={joystickSide === 'right'}
                    onClick={() => selectJoystickSide('right')}
                >
                    Right
                </button>
            </div>

            <p className="p4-vega__orientation-hint">
                For the best fullscreen experience, rotate your device to landscape.
            </p>
        </section>   
    );
}

export default P4Vega;
