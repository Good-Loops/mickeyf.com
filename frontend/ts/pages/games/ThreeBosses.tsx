/**
 * Local-only Three Bosses Unity WebGL page.
 *
 * The route is feature-gated by App.tsx and is never registered in production.
 */
import React, { useEffect, useRef, useState } from 'react';
import FullscreenButton from '@/components/FullscreenButton';
import { startThreeBossesWebGl, type UnityWebGlHandle } from '@/games/three-bosses/unityWebGl';
import { submitThreeBossesRun } from '@/services/leaderboardService';

type LoadState =
    | Readonly<{ kind: 'loading'; progress: number }>
    | Readonly<{ kind: 'running' }>
    | Readonly<{ kind: 'error'; message: string }>;

const describeLoadError = (error: unknown): string => {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error.trim()) return error;

    try {
        const serialized = JSON.stringify(error);
        if (serialized && serialized !== '{}') return serialized;
    } catch {
        // Fall through to the stable local-prototype message.
    }

    return 'The local WebGL build failed to load.';
};

const ThreeBosses: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const frameRef = useRef<HTMLDivElement | null>(null);
    const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading', progress: 0 });

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const controller = new AbortController();
        let cancelled = false;
        let handle: UnityWebGlHandle | null = null;

        (async () => {
            try {
                const nextHandle = await startThreeBossesWebGl({
                    canvas,
                    signal: controller.signal,
                    onProgress: (progress) => {
                        if (!cancelled) setLoadState({ kind: 'loading', progress });
                    },
                    submitRun: submitThreeBossesRun,
                });

                if (cancelled) {
                    await nextHandle.quit();
                    return;
                }

                handle = nextHandle;
                setLoadState({ kind: 'running' });
                canvas.focus();
            } catch (error) {
                if (cancelled || controller.signal.aborted) return;

                setLoadState({
                    kind: 'error',
                    message: describeLoadError(error),
                });
            }
        })();

        return () => {
            cancelled = true;
            controller.abort();
            if (handle) {
                void handle.quit().catch((error: unknown) => {
                    console.error('Three Bosses WebGL cleanup failed.', error);
                });
            }
        };
    }, []);

    const progressPercent = loadState.kind === 'loading'
        ? Math.round(loadState.progress * 100)
        : 100;

    return (
        <section className="three-bosses" data-three-bosses-local>
            <h1 className="u-visually-hidden">Three Bosses</h1>
            <p className="three-bosses__local-note">Local WebGL playability prototype</p>

            <div className="three-bosses__canvas-wrapper" ref={frameRef}>
                <canvas
                    aria-label="Three Bosses game"
                    className="three-bosses__canvas"
                    height={540}
                    id="three-bosses-unity-canvas"
                    ref={canvasRef}
                    tabIndex={0}
                    width={960}
                />

                {loadState.kind !== 'running' && (
                    <div className="three-bosses__status" role={loadState.kind === 'error' ? 'alert' : 'status'}>
                        {loadState.kind === 'loading'
                            ? `Loading Three Bosses… ${progressPercent}%`
                            : loadState.message}
                    </div>
                )}

                <FullscreenButton
                    targetRef={frameRef}
                    focusRef={canvasRef}
                    className="three-bosses__fullscreen-btn"
                />
            </div>

            <p className="three-bosses__orientation-hint">
                For the best fullscreen experience, rotate your device to landscape.
            </p>
        </section>
    );
};

export default ThreeBosses;
