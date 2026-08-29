/**
 * Dancing Circles page ("/animations/dancing-circles").
 * Wires the PIXI animation runner and audio engine controls into a page-scoped UI.
 * Mount/unmount starts/stops the imperative animation and audio resources.
 */
import React, { useEffect, useRef, useState } from "react";
import {
    DEFAULT_DANCING_CIRCLES_CUSTOM_COLOR,
    runDancingCircles,
} from "@/animations/dancing circles/runDancingCircles";
import FullscreenButton from "@/components/FullscreenButton";
import MusicControls from "@/components/MusicControls";
import { audioEngine } from "@/animations/helpers/audio/AudioEngine";
import { useAudioEngineState } from "@/hooks/useAudioEngineState";
import { CANVAS_WIDTH } from "@/utils/constants";

type HsvColor = { hue: number; saturation: number; value: number };

const hsvToHex = ({ hue, saturation, value }: HsvColor) => {
    const chroma = value * saturation;
    const hueSection = hue / 60;
    const secondComponent = chroma * (1 - Math.abs((hueSection % 2) - 1));
    const [red, green, blue] = hueSection < 1 ? [chroma, secondComponent, 0]
        : hueSection < 2 ? [secondComponent, chroma, 0]
        : hueSection < 3 ? [0, chroma, secondComponent]
        : hueSection < 4 ? [0, secondComponent, chroma]
        : hueSection < 5 ? [secondComponent, 0, chroma]
        : [chroma, 0, secondComponent];
    const offset = value - chroma;
    const toHex = (channel: number) => Math.round((channel + offset) * 255).toString(16).padStart(2, "0");

    return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
};

const hexToHsv = (hex: string): HsvColor => {
    const [red, green, blue] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const chroma = maximum - minimum;
    let hue = 0;

    if (chroma && maximum === red) hue = 60 * (((green - blue) / chroma) % 6);
    if (chroma && maximum === green) hue = 60 * ((blue - red) / chroma + 2);
    if (chroma && maximum === blue) hue = 60 * ((red - green) / chroma + 4);

    return {
        hue: hue < 0 ? hue + 360 : hue,
        saturation: maximum === 0 ? 0 : chroma / maximum,
        value: maximum,
    };
};

const DancingCircles: React.FC = () => {
	const canvasWrapperRef = useRef<HTMLDivElement | null>(null);
	const audioInputRef = useRef<HTMLInputElement | null>(null);
	const [backgroundColor, setBackgroundColor] = useState(DEFAULT_DANCING_CIRCLES_CUSTOM_COLOR);
	const [usesAnimatedBackground, setUsesAnimatedBackground] = useState(true);
	const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
	const [pickerColor, setPickerColor] = useState<HsvColor>(() => hexToHsv(DEFAULT_DANCING_CIRCLES_CUSTOM_COLOR));
	const audio = useAudioEngineState();

	useEffect(() => {
		if (!canvasWrapperRef.current) return;

		let dispose: (() => void) | undefined;

		(async () => {
			dispose = await runDancingCircles({
				container: canvasWrapperRef.current!,
			});
		})();

		return () => {
            // Must dispose on unmount to prevent duplicate loops.
			dispose?.();
		};
	}, []);

    // Hook upload button to audio engine
	useEffect(() => {
        const input = audioInputRef.current;
        if (!input) return;

        return audioEngine.initializeUploadButton(input);
    }, []);

	// Stop audio on unmount
	useEffect(() => {
        return () => {
            audioEngine.dispose();
        };
    }, []);

	const handlePlay = () => audioEngine.play();
    const handlePause = () => audioEngine.pause();
    const handleStop = () => audioEngine.stop();

    const handleUploadKeyDown = (event: React.KeyboardEvent<HTMLLabelElement>) => {
        if (event.key !== "Enter" && event.key !== " ") return;

        event.preventDefault();
        audioInputRef.current?.click();
    };

    const applyBackgroundColor = (nextColor: string, nextPickerColor = hexToHsv(nextColor)) => {
        setBackgroundColor(nextColor);
        setPickerColor(nextPickerColor);
        setUsesAnimatedBackground(false);
    };

    const restoreAnimatedBackground = () => {
        setUsesAnimatedBackground(true);
        setIsColorPickerOpen(false);
    };

    const openColorPicker = () => {
        setUsesAnimatedBackground(false);
        setIsColorPickerOpen((isOpen) => !isOpen);
    };

    const updateSaturationAndValue = (event: React.PointerEvent<HTMLDivElement>) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const saturation = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
        const value = Math.min(1, Math.max(0, 1 - (event.clientY - bounds.top) / bounds.height));
        const nextPickerColor = { ...pickerColor, saturation, value };

        applyBackgroundColor(hsvToHex(nextPickerColor), nextPickerColor);
    };

    const handleColorFieldPointer = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.type === "pointermove" && event.buttons !== 1) return;

        event.currentTarget.setPointerCapture(event.pointerId);
        updateSaturationAndValue(event);
    };

    const handleHueChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const nextPickerColor = { ...pickerColor, hue: Number(event.target.value) };
        applyBackgroundColor(hsvToHex(nextPickerColor), nextPickerColor);
    };

    const handleColorFieldKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const adjustment = event.shiftKey ? .1 : .02;
        let { saturation, value } = pickerColor;

        if (event.key === "ArrowLeft") saturation -= adjustment;
        else if (event.key === "ArrowRight") saturation += adjustment;
        else if (event.key === "ArrowDown") value -= adjustment;
        else if (event.key === "ArrowUp") value += adjustment;
        else return;

        event.preventDefault();
        const nextPickerColor = {
            ...pickerColor,
            saturation: Math.min(1, Math.max(0, saturation)),
            value: Math.min(1, Math.max(0, value)),
        };
        applyBackgroundColor(hsvToHex(nextPickerColor), nextPickerColor);
    };

    const pageStyle = {
        "--canvas-width": `${CANVAS_WIDTH}px`,
        "--dancing-circles-background": backgroundColor,
    } as React.CSSProperties;

	return (
		<section
            className={`dancing-circles${usesAnimatedBackground ? "" : " dancing-circles--custom-background"}`}
            style={pageStyle}
        >
			<h1 className="u-visually-hidden">Dancing Circles</h1>

			<div 
				className="dancing-circles__canvas-wrapper" 
				ref={canvasWrapperRef}
			>
				<FullscreenButton
					targetRef={canvasWrapperRef}
					className="dancing-circles__fullscreen-btn"
				/>
    	   </div>

            <p className="dancing-circles__orientation-hint">
                For the best fullscreen experience, rotate your device to landscape.
            </p>

			<div className="dancing-circles__transport">
                <div className="dancing-circles__transport-controls">
                    <MusicControls
                        hasAudio={audio.hasAudio}
                        isPlaying={audio.playing}
                        onPlay={handlePlay}
                        onPause={handlePause}
                        onStop={handleStop}
                    />
                </div>

                <div className="dancing-circles__upload">
                    <label
                        className="dancing-circles__upload-btn"
                        htmlFor="dancing-circles-file-upload"
                        role="button"
                        tabIndex={0}
                        onKeyDown={handleUploadKeyDown}
                    >
                        Upload Music
                    </label>
                    <input
                        id="dancing-circles-file-upload"
                        type="file"
                        accept="audio/*"
                        className="dancing-circles__input"
                        ref={audioInputRef}
                    />
                </div>

                <div
                    className="dancing-circles__background-controls"
                    role="group"
                    aria-label="Canvas background"
                >
                    <span className="dancing-circles__background-label" aria-hidden="true">
                        Background
                    </span>
                    <button
                        className="dancing-circles__background-mode"
                        type="button"
                        aria-pressed={usesAnimatedBackground}
                        onClick={restoreAnimatedBackground}
                    >
                        <span>Breathing</span>
                        {usesAnimatedBackground && (
                            <span className="dancing-circles__background-state" aria-hidden="true">
                                ✓
                            </span>
                        )}
                    </button>
                    <button
                        className="dancing-circles__background-mode dancing-circles__background-mode--custom"
                        type="button"
                        aria-pressed={!usesAnimatedBackground}
                        aria-expanded={isColorPickerOpen}
                        onClick={openColorPicker}
                    >
                        <span
                            className="dancing-circles__color-swatch"
                            style={{ backgroundColor }}
                            aria-hidden="true"
                        />
                        <span>Custom color</span>
                        {!usesAnimatedBackground && (
                            <span className="dancing-circles__background-state" aria-hidden="true">
                                ✓
                            </span>
                        )}
                    </button>
                    {isColorPickerOpen && (
                        <div className="dancing-circles__color-picker" aria-label="Choose a canvas background color">
                            <div
                                className="dancing-circles__color-field"
                                style={{ backgroundColor: `hsl(${pickerColor.hue} 100% 50%)` }}
                                role="slider"
                                aria-label="Color saturation and brightness"
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={Math.round(pickerColor.saturation * 100)}
                                aria-valuetext={`${Math.round(pickerColor.saturation * 100)}% saturation, ${Math.round(pickerColor.value * 100)}% brightness`}
                                tabIndex={0}
                                onPointerDown={handleColorFieldPointer}
                                onPointerMove={handleColorFieldPointer}
                                onKeyDown={handleColorFieldKeyDown}
                            >
                                <span
                                    className="dancing-circles__color-field-handle"
                                    style={{
                                        left: `${pickerColor.saturation * 100}%`,
                                        top: `${(1 - pickerColor.value) * 100}%`,
                                    }}
                                />
                            </div>
                            <label className="dancing-circles__hue-control">
                                <span className="u-visually-hidden">Hue</span>
                                <input
                                    type="range"
                                    min="0"
                                    max="359"
                                    value={pickerColor.hue}
                                    onChange={handleHueChange}
                                />
                            </label>
                        </div>
                    )}
                </div>
            </div>
		</section>
	);
};

export default DancingCircles;
