/**
 * Dancing Fractals page ("/animations/dancing-fractals").
 * Hosts a PIXI fractal canvas and composes the configuration + music controls UI.
 * Owns mount/unmount of the imperative fractal host and related monitoring loops.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { type TreeConfig, defaultTreeConfig } from '@/animations/dancing fractals/config/TreeConfig'; 
import TreeControls from '@/animations/dancing fractals/components/TreeControls';
import { Tree } from '@/animations/dancing fractals/fractals/Tree';

import { type FlowerSpiralConfig, defaultFlowerSpiralConfig } from '@/animations/dancing fractals/config/FlowerSpiralConfig';
import FlowerSpiralControls from '@/animations/dancing fractals/components/FlowerSpiralControls';
import { FlowerSpiral } from '@/animations/dancing fractals/fractals/FlowerSpiral';

import { type MandelbrotConfig, defaultMandelbrotConfig } from '@/animations/dancing fractals/config/MandelbrotConfig';
import MandelbrotControls from '@/animations/dancing fractals/components/MandelbrotControls';
import { Mandelbrot } from '@/animations/dancing fractals/fractals/Mandelbrot';

import { FractalHost } from '@/animations/dancing fractals/interfaces/FractalHost';
import { createFractalHost } from '@/animations/dancing fractals/createFractalHost';
import type { FractalAnimationConstructor } from '@/animations/dancing fractals/interfaces/FractalAnimation';

import { audioEngine } from '@/animations/helpers/audio/AudioEngine';
import { useAudioEngineState } from '@/hooks/useAudioEngineState';
import notAllowedCursor from '@/assets/cursors/notallowed.cur';
import Dropdown from '@/components/Dropdown';
import FullscreenButton from '@/components/FullscreenButton';
import MusicControls from '@/components/MusicControls';
import MusicUpload from '@/components/MusicUpload';

type FractalKind = 'tree' | 'flower' | 'mandelbrot';

type FractalEntry<C> = {
    ctor: FractalAnimationConstructor<C>;
    getConfig: () => C;
};

const DancingFractals: React.FC = () => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [host, setHost] = useState<FractalHost | null>(null);
    const audio = useAudioEngineState();

     // Which fractal is currently selected
    const [fractalKind, setFractalKind] = useState<FractalKind>('tree');

    const [autoDisposeEnabled, setAutoDisposeEnabled] = useState(false);
    const [lifetime, setLifetime] = useState(30); // seconds
    const [remainingLifetime, setRemainingLifetime] = useState<number | null>(null);

    const [fps, setFps] = useState<number | null>(null);


    // Separate config state for each fractal type
    const [treeConfig, setTreeConfig] = useState<TreeConfig>(defaultTreeConfig);
    const [flowerSpiralConfig, setFlowerSpiralConfig] = useState<FlowerSpiralConfig>(defaultFlowerSpiralConfig);
    const [mandelbrotConfig, setMandelbrotConfig] = useState<MandelbrotConfig>(defaultMandelbrotConfig);

    const cloneConfig = <T,>(cfg: T): T => {
        // structuredClone is available in modern browsers; fall back to JSON clone.
        const sc = (globalThis as any).structuredClone as ((v: T) => T) | undefined;
        return sc ? sc(cfg) : JSON.parse(JSON.stringify(cfg));
    };

    const FRACTALS = useMemo(() => ({
        tree: { ctor: Tree, getConfig: () => treeConfig },
        flower: { ctor: FlowerSpiral, getConfig: () => flowerSpiralConfig },
        mandelbrot: { ctor: Mandelbrot, getConfig: () => mandelbrotConfig },
    }) satisfies Record<FractalKind, FractalEntry<any>>, [treeConfig, flowerSpiralConfig, mandelbrotConfig]);

    // Create the host (PIXI app + canvas) once
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        let cancelled = false;
        let ownedHost: FractalHost | null = null;

        (async () => {
            const createdHost = await createFractalHost(container);

            if (cancelled) {
                createdHost.dispose();
                return;
            }

            ownedHost = createdHost;
            // Read current settings in the effects below, not this mount's stale closure.
            setHost(createdHost);
        })();

        return () => {
            // Must dispose on unmount to prevent leaks/duplicate loops.
            cancelled = true;
            ownedHost?.dispose();
        };
    }, []);

    // Initialize/switch with current config; slider patches must not recreate the animation.
    useEffect(() => {
        if (!host) return;

        const entry = FRACTALS[fractalKind];
        host.setFractal(entry.ctor as any, entry.getConfig());
    }, [host, fractalKind]);

    // Lifetime changes
    useEffect(() => {
        if (!host) return;

        host.setLifetime(autoDisposeEnabled ? lifetime : null);
    }, [host, autoDisposeEnabled, lifetime]);

    // FPS + remaining lifetime monitoring loop
    useEffect(() => {
        if (!host) return;
        let rafId: number;

        const loop = () => {
            const { fps: hostFps, remainingLifetime } = host.getStats();
            if (!Number.isNaN(hostFps) && hostFps > 0) {
                setFps(hostFps);
            }
            setRemainingLifetime(remainingLifetime);
            rafId = requestAnimationFrame(loop);
        };

        rafId = requestAnimationFrame(loop);

        return () => {
            cancelAnimationFrame(rafId);
        };
    }, [host]);

    // Stop audio on unmount
    useEffect(() => {
        return () => {
            audioEngine.dispose();
        };
    }, []);

    const handleRestart = () => { host?.restart(); };

    const handleResetDefaults = () => {
        if (audio.playing) return;
        if (fractalKind === 'tree') {
            const cfg = cloneConfig(defaultTreeConfig);
            setTreeConfig(cfg);
            host?.setFractal(Tree as any, cfg);
            return;
        }

        if (fractalKind === 'flower') {
            const cfg = cloneConfig(defaultFlowerSpiralConfig);
            setFlowerSpiralConfig(cfg);
            host?.setFractal(FlowerSpiral as any, cfg);
            return;
        }

        const cfg = cloneConfig(defaultMandelbrotConfig);
        setMandelbrotConfig(cfg);
        host?.setFractal(Mandelbrot as any, cfg);
    };

    const handleTreeConfigChange = (patch: Partial<TreeConfig>) => {
        setTreeConfig(prev => ({ ...prev, ...patch }));
        host?.updateConfig(patch);
    };

    const handleFlowerConfigChange = (patch: Partial<FlowerSpiralConfig>) => {
        setFlowerSpiralConfig(prev => ({ ...prev, ...patch }));
        host?.updateConfig(patch);
    };

    const handleMandelbrotConfigChange = (patch: Partial<MandelbrotConfig>) => {
        setMandelbrotConfig(prev => ({ ...prev, ...patch }));
        host?.updateConfig(patch);
    };

    const uiClassName = 
        'dancing-fractals__ui' +
        (audio.playing ? ' dancing-fractals__ui--locked' : '');

    const uiStyle = audio.playing
        ? { cursor: `url(${notAllowedCursor}), not-allowed` }
        : undefined;

    const handlePlay = () => audioEngine.play();
    const handlePause = () => audioEngine.pause();
    const handleStop = () => audioEngine.stop();

    return (
        <section className='dancing-fractals'>
            <aside className={uiClassName} style={uiStyle}>
                {audio.playing && (
                    <div className="dancing-fractals__ui--overlay" />
                )}

                <Dropdown
                    options={[
                        { value: 'tree', label: 'Tree' },
                        { value: 'flower', label: 'Flower Spiral' },
                        { value: 'mandelbrot', label: 'Mandelbrot' },
                    ]}
                    value={fractalKind}
                    onChange={(val) => setFractalKind(val as FractalKind)}
                    disabled={audio.playing}
                    className="dancing-fractals__ui--dropdown"
                    buttonClassName="dancing-fractals__ui--dropdown-button"
                    selectedClassName="dancing-fractals__ui--dropdown-selected"
                    caretClassName="dancing-fractals__ui--dropdown-caret"
                    menuClassName="dancing-fractals__ui--dropdown-menu"
                    optionClassName="dancing-fractals__ui--dropdown-option"
                />

                <button className="dancing-fractals__ui--restart-btn"
                    type="button"
                    onClick={handleRestart}
                    disabled={audio.playing}
                >
                    Restart
                </button>

                <button className="dancing-fractals__ui--restart-btn"
                    type="button"
                    onClick={handleResetDefaults}
                    disabled={audio.playing}
                >
                    Reset defaults
                </button>

                <div className="dancing-fractals__ui--lifetime">
                    <label className="dancing-fractals__ui--checkbox">
                        <input
                            type="checkbox"
                            checked={autoDisposeEnabled}
                            onChange={e => setAutoDisposeEnabled(e.target.checked)}
                            disabled={audio.playing}
                        />
                        <span className="dancing-fractals__ui--checkbox-box" />
                        <span className="dancing-fractals__ui--checkbox-text">Auto-dispose</span>
                    </label>

                    <label className="dancing-fractals__ui--lifetime-slider">
                        Lifetime:{" "}
                        {autoDisposeEnabled ? `${lifetime.toFixed(0)}s` : "∞"}
                        <input
                            type="range"
                            min={5}
                            max={60}
                            step={1}
                            disabled={!autoDisposeEnabled || audio.playing}
                            value={lifetime}
                            onChange={e =>
                                setLifetime(Number(e.target.value))
                            }
                            className='dancing-fractals__ui--slider'
                        />
                    </label>
                </div>

                <div className="dancing-fractals__ui--controls-wrapper">
                    {fractalKind === 'tree' && (
                        <TreeControls
                            config={treeConfig}
                            onChange={patch => {
                                if(audio.playing) return;
                                handleTreeConfigChange(patch);
                            }}
                        />
                    )}

                    {fractalKind === 'flower' && (
                        <FlowerSpiralControls
                            config={flowerSpiralConfig}
                            onChange={patch => {
                                if(audio.playing) return;
                                handleFlowerConfigChange(patch);
                            }}
                        />
                    )}

                    {fractalKind === 'mandelbrot' && (
                        <MandelbrotControls
                            config={mandelbrotConfig}
                            onChange={patch => {
                                if (audio.playing) return;
                                handleMandelbrotConfigChange(patch);
                            }}
                        />
                    )}
                </div>

                {fps !== null && (
                    <div className="dancing-fractals__ui--debug">
                        <span>FPS: {fps.toFixed(1)}</span>
                        {autoDisposeEnabled && remainingLifetime !== null && (
                            <>
                                <span> · </span>
                                <span>
                                    Time left: {remainingLifetime.toFixed(1)}s
                                </span>
                            </>
                        )}
                    </div>
                )}
            </aside>

            <div className="dancing-fractals__stage">

                <div className="dancing-fractals__canvas-wrapper" ref={containerRef}>
                    <h1 className='u-visually-hidden'>Dancing Fractals</h1>
                    <FullscreenButton 
                        targetRef={containerRef} 
                        className='dancing-fractals__fullscreen-btn'
                    />
                </div>

                <div className="dancing-fractals__transport">
                    <div className="dancing-fractals__transport-left">
                        <MusicControls
                            hasAudio={audio.hasAudio}
                            isPlaying={audio.playing}
                            onPlay={handlePlay}
                            onPause={handlePause}
                            onStop={handleStop}
                        />
                    </div>

                    <MusicUpload
                        id="fractal-music-upload"
                        classPrefix="dancing-fractals"
                        onFileSelect={(file) => audioEngine.processAudio(file)}
                    />
                </div>

            </div>

            <p className="dancing-fractals__orientation-hint">
                For the best fullscreen experience, rotate your device to landscape.
            </p>
            <div className="dancing-fractals__ghost" aria-hidden="true" />
        </section>   
    );
}

export default DancingFractals;
