/**
 * p4-Vega game page ("/games/p4-Vega").
 * Mounts the PIXI game runner and provides the page-level UI controls.
 * Unmount must dispose the runner to stop the loop and release resources.
 */
import React, { useEffect, useRef, useState } from "react";
import { useAuth } from '@/context/AuthContext';
import { p4Vega } from '@/games/p4-Vega/p4-Vega';
import FullscreenButton from "@/components/FullscreenButton";
import Dropdown from '@/components/Dropdown';

type JoystickSide = 'left' | 'right';

const JOYSTICK_SIDE_STORAGE_KEY = 'p4-vega-fullscreen-joystick-side';

const P4Vega: React.FC = () => {
    const canvasWrapperRef = useRef<HTMLDivElement | null>(null);
    const { isAuthenticated, loading } = useAuth();
    const isAuthenticatedRef = useRef(isAuthenticated);

    isAuthenticatedRef.current = isAuthenticated;

    const [selectedKey, setSelectedKey] = useState<string>('C');
    const [selectedScale, setSelectedScale] = useState<string>('Major');
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

        let dispose: (() => void) | undefined;
        let cancelled = false;
        const container = canvasWrapperRef.current;

        (async () => {
            const nextDispose = await p4Vega(container, {
                isAuthenticated: () => isAuthenticatedRef.current,
            });

            if (cancelled) {
                nextDispose();
                return;
            }

            dispose = nextDispose;
        })();

        return () => {
            // Must dispose on unmount to prevent duplicate loops.
            cancelled = true;
            dispose?.();
        };
    }, [loading]);

    return (
        <section className='p4-vega' data-p4-vega data-joystick-side={joystickSide}>
            <h1 className='u-visually-hidden'>p4-Vega</h1>

            <div
                className="p4-vega__canvas-wrapper"
                ref={canvasWrapperRef}
            >
                <FullscreenButton
                    targetRef={canvasWrapperRef}
                    className="p4-vega__fullscreen-btn"
                />
                <button
                    type="button"
                    className="p4-vega__joystick p4-vega__joystick--fullscreen"
                    data-p4-joystick
                    aria-label="Movement joystick"
                >
                    <span className="p4-vega__joystick-thumb" data-p4-joystick-thumb />
                </button>
            </div>

            <div className='p4-vega__ui'>
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
