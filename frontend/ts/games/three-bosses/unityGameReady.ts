export const THREE_BOSSES_GAME_READY_TIMEOUT_MS = 30_000 as const;

type ThreeBossesReadyWindow = {
    mickeyfThreeBossesSignalReady?: () => void;
};

declare global {
    interface Window {
        mickeyfThreeBossesSignalReady?: () => void;
    }
}

type GameReadyClock = Readonly<{
    schedule: (callback: () => void, delayMs: number) => number;
    cancel: (timeoutId: number) => void;
}>;

export type ThreeBossesGameReadyBinding = Readonly<{
    promise: Promise<void>;
    startTimeout: () => void;
    release: () => void;
}>;

/**
 * Yields the canvas to Unity before waiting for its post-splash menu frame.
 * These are separate milestones: the browser must stop covering Unity's own
 * splash, while gameplay bindings still wait for the rendered main menu.
 */
export const handOffThreeBossesCanvas = async (
    binding: ThreeBossesGameReadyBinding,
    onCanvasOwned: () => void = () => undefined,
): Promise<void> => {
    onCanvasOwned();
    binding.startTimeout();
    await binding.promise;
};

const browserClock: GameReadyClock = {
    schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
    cancel: (timeoutId) => window.clearTimeout(timeoutId),
};

/**
 * Installs Unity's readiness callback immediately, but starts its deadline only
 * after the Unity loader has finished. Cold WebAssembly compilation belongs to
 * the loader phase and must not consume the main-menu rendering allowance.
 */
export const bindThreeBossesGameReady = (
    signal: AbortSignal,
    readyWindow: ThreeBossesReadyWindow = window,
    clock: GameReadyClock = browserClock,
    timeoutMs: number = THREE_BOSSES_GAME_READY_TIMEOUT_MS,
): ThreeBossesGameReadyBinding => {
    if (readyWindow.mickeyfThreeBossesSignalReady !== undefined) {
        throw new Error('A Three Bosses readiness bridge is already active.');
    }

    let settled = false;
    let timeoutId: number | null = null;
    let resolveReady: (() => void) | null = null;
    let rejectReady: ((reason: unknown) => void) | null = null;

    const clear = () => {
        if (timeoutId !== null) {
            clock.cancel(timeoutId);
            timeoutId = null;
        }
        signal.removeEventListener('abort', onAbort);
        if (readyWindow.mickeyfThreeBossesSignalReady === onReady) {
            delete readyWindow.mickeyfThreeBossesSignalReady;
        }
    };
    const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clear();
        callback();
    };
    const onReady = () => finish(() => resolveReady?.());
    const onAbort = () => finish(() => rejectReady?.(
        new DOMException('The WebGL load was cancelled.', 'AbortError'),
    ));
    const promise = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });

    // Unity can still be compiling when route cleanup aborts this binding.
    // Observe that early rejection immediately; callers still receive the
    // original rejecting promise when they reach the readiness await.
    void promise.catch(() => undefined);

    readyWindow.mickeyfThreeBossesSignalReady = onReady;
    signal.addEventListener('abort', onAbort, { once: true });

    if (signal.aborted) onAbort();

    return {
        promise,
        startTimeout: () => {
            if (settled || timeoutId !== null) return;

            timeoutId = clock.schedule(() => finish(() => rejectReady?.(
                new Error('The Three Bosses main menu did not become ready in time.'),
            )), timeoutMs);
        },
        release: clear,
    };
};
