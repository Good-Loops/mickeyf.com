import React, { useEffect, useRef, useState } from 'react';
import FullscreenButton from '@/components/FullscreenButton';
import ScoreSubmissionNotice from '@/components/ScoreSubmissionNotice';
import { isThreeBossesLocalEnabled } from '@/config/featureFlags';
import { useAuth } from '@/context/AuthContext';
import { isThreeBossesAvailableInCurrentBrowser } from '@/games/three-bosses/unityVisibility';
import { startThreeBossesWebGl, type UnityWebGlHandle } from '@/games/three-bosses/unityWebGl';
import {
    getLeaderboardCatalog,
    issueThreeBossesRunTicket,
    isThreeBossesSubmissionEnabled,
    submitThreeBossesRun,
} from '@/services/leaderboardService';

type LoadState =
    | Readonly<{ kind: 'loading'; progress: number }>
    | Readonly<{ kind: 'running' }>
    | Readonly<{ kind: 'error'; message: string }>;

const SUBMISSION_GATE_ATTEMPTS = 3;
const SUBMISSION_GATE_ATTEMPT_TIMEOUT_MS = 5_000;
const SUBMISSION_GATE_RETRY_DELAY_MS = 750;

type LeaderboardCatalogReader = typeof getLeaderboardCatalog;

type ThreeBossesLoadingStatusProps = Readonly<{
    progressPercent: number;
}>;

type ThreeBossesControlBinding = Readonly<{
    action: string;
    keys: readonly string[];
    alternateKeys?: readonly string[];
}>;

const THREE_BOSSES_DESKTOP_CONTROLS: readonly ThreeBossesControlBinding[] = [
    { keys: ['A', 'D'], alternateKeys: ['←', '→'], action: 'Move left / right' },
    { keys: ['W', 'A', 'D'], action: 'Aim up / left / right' },
    { keys: ['Space'], action: 'Jump / double jump' },
    { keys: ['Left Shift'], action: 'Dash' },
    { keys: ['Enter'], action: 'Fire' },
    { keys: ['Esc'], action: 'Pause / resume' },
];

const ThreeBossesControlKeyGroup: React.FC<Readonly<{ keys: readonly string[] }>> = ({
    keys,
}) => (
    <span className="three-bosses__control-key-group">
        {keys.map((key, index) => (
            <React.Fragment key={key}>
                {index > 0 && (
                    <span aria-hidden="true" className="three-bosses__control-separator">
                        /
                    </span>
                )}
                <kbd>{key}</kbd>
            </React.Fragment>
        ))}
    </span>
);

const clampProgressPercent = (progressPercent: number): number => (
    Math.min(100, Math.max(0, Math.round(progressPercent)))
);

export const ThreeBossesLoadingStatus: React.FC<ThreeBossesLoadingStatusProps> = ({
    progressPercent,
}) => {
    const normalizedProgress = clampProgressPercent(progressPercent);

    return (
        <div className="three-bosses__loading">
            <span className="three-bosses__loading-eyebrow">Preparing arena</span>
            <div className="three-bosses__loading-bosses" aria-hidden="true">
                <span className="three-bosses__loading-boss three-bosses__loading-boss--bee">I</span>
                <span className="three-bosses__loading-boss three-bosses__loading-boss--cyborg">II</span>
                <span className="three-bosses__loading-boss three-bosses__loading-boss--kraken">III</span>
            </div>
            <span className="three-bosses__loading-title">Three Bosses</span>
            <div className="three-bosses__loading-progress">
                <div
                    aria-label="Loading Three Bosses"
                    aria-valuemax={100}
                    aria-valuemin={0}
                    aria-valuenow={normalizedProgress}
                    className="three-bosses__loading-track"
                    role="progressbar"
                >
                    <span
                        className="three-bosses__loading-fill"
                        style={{ width: `${normalizedProgress}%` }}
                    />
                </div>
                <span className="three-bosses__loading-percent" aria-hidden="true">
                    {normalizedProgress}%
                </span>
            </div>
        </div>
    );
};

export const ThreeBossesControlsGuide: React.FC = () => (
    <section
        aria-labelledby="three-bosses-controls-title"
        className="three-bosses__controls"
    >
        <h2 className="three-bosses__controls-title" id="three-bosses-controls-title">
            Keyboard controls
        </h2>
        <dl className="three-bosses__controls-list">
            {THREE_BOSSES_DESKTOP_CONTROLS.map(({ action, alternateKeys, keys }) => (
                <div className="three-bosses__control" key={action}>
                    <dt className="three-bosses__control-keys">
                        <ThreeBossesControlKeyGroup keys={keys} />
                        {alternateKeys && (
                            <>
                                <span className="three-bosses__control-alternative">or</span>
                                <ThreeBossesControlKeyGroup keys={alternateKeys} />
                            </>
                        )}
                    </dt>
                    <dd className="three-bosses__control-action">{action}</dd>
                </div>
            ))}
        </dl>
    </section>
);

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

const waitForSubmissionGateRetry = (
    signal: AbortSignal,
    delayMs: number,
): Promise<boolean> => new Promise((resolve) => {
    if (signal.aborted) {
        resolve(false);
        return;
    }

    const onAbort = () => {
        clearTimeout(timeoutId);
        resolve(false);
    };
    const timeoutId = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
    }, delayMs);

    signal.addEventListener('abort', onAbort, { once: true });
});

const readSubmissionGateAttempt = async (
    signal: AbortSignal,
    readCatalog: LeaderboardCatalogReader,
): Promise<boolean> => {
    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort();
    const timeoutId = setTimeout(abortAttempt, SUBMISSION_GATE_ATTEMPT_TIMEOUT_MS);

    if (signal.aborted) abortAttempt();
    else signal.addEventListener('abort', abortAttempt, { once: true });

    try {
        const catalog = await readCatalog(attemptController.signal);
        return catalog.games.some(isThreeBossesSubmissionEnabled);
    } finally {
        clearTimeout(timeoutId);
        signal.removeEventListener('abort', abortAttempt);
    }
};

export const readThreeBossesSubmissionGate = async (
    signal: AbortSignal,
    readCatalog: LeaderboardCatalogReader = getLeaderboardCatalog,
    retryDelayMs: number = SUBMISSION_GATE_RETRY_DELAY_MS,
): Promise<boolean> => {
    for (let attempt = 1; attempt <= SUBMISSION_GATE_ATTEMPTS; attempt += 1) {
        try {
            return await readSubmissionGateAttempt(signal, readCatalog);
        } catch {
            if (signal.aborted || attempt === SUBMISSION_GATE_ATTEMPTS) return false;
            if (!await waitForSubmissionGateRetry(signal, retryDelayMs)) return false;
        }
    }

    return false;
};

const ThreeBosses: React.FC = () => {
    const { isAuthenticated, loading: authLoading } = useAuth();
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const frameRef = useRef<HTMLDivElement | null>(null);
    const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading', progress: 0 });
    const [hasUnityCanvasControl, setHasUnityCanvasControl] = useState(false);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const controller = new AbortController();
        let cancelled = false;
        let handle: UnityWebGlHandle | null = null;

        setHasUnityCanvasControl(false);

        (async () => {
            try {
                const submissionGatePromise = readThreeBossesSubmissionGate(controller.signal);
                const nextHandle = await startThreeBossesWebGl({
                    canvas,
                    signal: controller.signal,
                    onProgress: (progress) => {
                        if (!cancelled) setLoadState({ kind: 'loading', progress });
                    },
                    onCanvasOwned: () => {
                        if (!cancelled) setHasUnityCanvasControl(true);
                    },
                    issueRunTicket: issueThreeBossesRunTicket,
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
    const showStatus = loadState.kind === 'error'
        || (loadState.kind === 'loading' && !hasUnityCanvasControl);

    return (
        <section className="three-bosses">
            <h1 className="u-visually-hidden">Three Bosses</h1>
            {isThreeBossesLocalEnabled && (
                <p className="three-bosses__local-note">Local WebGL playability prototype</p>
            )}
            <ScoreSubmissionNotice
                isAuthenticated={isAuthenticated}
                loading={authLoading}
            />

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

                {showStatus && (
                    <div
                        aria-atomic="true"
                        className="three-bosses__status"
                        role={loadState.kind === 'error' ? 'alert' : 'status'}
                    >
                        {loadState.kind === 'loading' ? (
                            <ThreeBossesLoadingStatus progressPercent={progressPercent} />
                        ) : (
                            <div className="three-bosses__load-error">
                                <span className="three-bosses__load-error-title">
                                    Startup interrupted
                                </span>
                                <span className="three-bosses__load-error-message">
                                    {loadState.message}
                                </span>
                            </div>
                        )}
                    </div>
                )}

                <FullscreenButton
                    targetRef={frameRef}
                    focusRef={canvasRef}
                    className="three-bosses__fullscreen-btn"
                />
            </div>

            <ThreeBossesControlsGuide />

            <p className="three-bosses__orientation-hint">
                For the best fullscreen experience, rotate your device to landscape.
            </p>
        </section>
    );
};

export const ThreeBossesDesktopOnly: React.FC = () => (
    <section className="three-bosses three-bosses--desktop-only">
        <h1 className="u-visually-hidden">Three Bosses</h1>
        <p className="three-bosses__availability-note" role="status">
            Three Bosses is currently available on desktop only.
        </p>
    </section>
);

export const ThreeBossesAvailabilityGate: React.FC = () => (
    isThreeBossesAvailableInCurrentBrowser()
        ? <ThreeBosses />
        : <ThreeBossesDesktopOnly />
);

export default ThreeBosses;
