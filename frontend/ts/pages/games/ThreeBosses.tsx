import React, { useEffect, useRef, useState } from 'react';
import FullscreenButton from '@/components/FullscreenButton';
import { isThreeBossesLocalEnabled } from '@/config/featureFlags';
import { startThreeBossesWebGl, type UnityWebGlHandle } from '@/games/three-bosses/unityWebGl';
import {
    getLeaderboardCatalog,
    isThreeBossesSubmissionEnabled,
    submitThreeBossesRun,
} from '@/services/leaderboardService';

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
        // Fall through to the stable user-facing message.
    }

    return 'The Three Bosses WebGL game failed to load.';
};

const readSubmissionGate = async (signal: AbortSignal): Promise<boolean> => {
    try {
        const catalog = await getLeaderboardCatalog(signal);
        return catalog.games.some(isThreeBossesSubmissionEnabled);
    } catch {
        // Game loading remains independent from the API. Any catalog failure
        // keeps the Unity submit control fail-closed.
        return false;
    }
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
                const submissionGatePromise = readSubmissionGate(controller.signal);
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

                const submissionEnabled = await submissionGatePromise;
                if (!cancelled)
                    nextHandle.setSubmissionEnabled(submissionEnabled);
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
        <section className="three-bosses">
            <h1 className="u-visually-hidden">Three Bosses</h1>
            {isThreeBossesLocalEnabled && (
                <p className="three-bosses__local-note">Local WebGL playability prototype</p>
            )}

            <div
                className="three-bosses__canvas-wrapper"
                data-three-bosses-state={loadState.kind}
                ref={frameRef}
            >
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
