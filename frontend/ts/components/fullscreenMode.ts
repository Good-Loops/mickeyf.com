/**
 * Cross-browser fullscreen boundary for canvas wrappers.
 *
 * iPhone Safari does not expose element fullscreen for ordinary DOM content,
 * so unsupported browsers receive a reversible, viewport-filling CSS mode.
 */

export const CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE = 'data-canvas-fullscreen';
export const CANVAS_FULLSCREEN_FALLBACK_VALUE = 'fallback';
export const CANVAS_FULLSCREEN_ROOT_CLASS = 'canvas-fullscreen-fallback-active';
export const NATIVE_FULLSCREEN_CONFIRMATION_TIMEOUT_MS = 200;

type WebKitFullscreenDocument = Document & {
    webkitExitFullscreen?: () => Promise<void> | void;
    webkitFullscreenElement?: Element | null;
};

type WebKitFullscreenElement = HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
};

type FallbackIsolationEntry = Readonly<{
    element: HTMLElement;
    wasAlreadyInert: boolean;
}>;

const fallbackIsolationByTarget = new WeakMap<HTMLElement, FallbackIsolationEntry[]>();
const lateNativeCleanupByTarget = new WeakMap<HTMLElement, () => void>();

const readNativeFullscreenElement = (
    fullscreenDocument: WebKitFullscreenDocument,
): Element | null => (
    fullscreenDocument.fullscreenElement
    ?? fullscreenDocument.webkitFullscreenElement
    ?? null
);

const isFullscreenTargetConnected = (target: HTMLElement): boolean => target.isConnected;

export const isCanvasFullscreenFallback = (target: HTMLElement): boolean => (
    target.getAttribute(CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE)
    === CANVAS_FULLSCREEN_FALLBACK_VALUE
);

export const isCanvasFullscreen = (
    target: HTMLElement,
    fullscreenDocument: WebKitFullscreenDocument = document,
): boolean => (
    readNativeFullscreenElement(fullscreenDocument) === target
    || isCanvasFullscreenFallback(target)
);

const restoreFallbackIsolation = (target: HTMLElement): void => {
    const entries = fallbackIsolationByTarget.get(target) ?? [];
    fallbackIsolationByTarget.delete(target);

    for (const { element, wasAlreadyInert } of entries) {
        if (!wasAlreadyInert) element.removeAttribute('inert');
    }
};

const isolateFallbackTarget = (target: HTMLElement): void => {
    const entries: FallbackIsolationEntry[] = [];
    let branch: HTMLElement | null = target;

    while (branch?.parentElement) {
        const parent: HTMLElement = branch.parentElement;
        for (const sibling of Array.from(parent.children)) {
            if (
                sibling === branch
                || typeof (sibling as HTMLElement).setAttribute !== 'function'
            ) {
                continue;
            }

            const element = sibling as HTMLElement;
            const wasAlreadyInert = element.hasAttribute('inert');
            element.setAttribute('inert', '');
            entries.push({ element, wasAlreadyInert });
        }
        branch = parent;
    }

    fallbackIsolationByTarget.set(target, entries);
};

const enableCanvasFullscreenFallback = (
    target: HTMLElement,
    fullscreenDocument: WebKitFullscreenDocument,
): void => {
    const activeFallback = fullscreenDocument.querySelector<HTMLElement>(
        `[${CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE}="${CANVAS_FULLSCREEN_FALLBACK_VALUE}"]`,
    );

    if (activeFallback && activeFallback !== target) {
        clearCanvasFullscreenFallback(activeFallback, fullscreenDocument);
    }

    target.setAttribute(
        CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE,
        CANVAS_FULLSCREEN_FALLBACK_VALUE,
    );
    isolateFallbackTarget(target);
    fullscreenDocument.documentElement.classList.add(CANVAS_FULLSCREEN_ROOT_CLASS);
};

const watchForLateNativeFullscreen = (
    target: HTMLElement,
    fullscreenDocument: WebKitFullscreenDocument,
): void => {
    lateNativeCleanupByTarget.get(target)?.();

    const stopWatching = () => {
        fullscreenDocument.removeEventListener('fullscreenchange', onChange);
        fullscreenDocument.removeEventListener('webkitfullscreenchange', onChange);
        lateNativeCleanupByTarget.delete(target);
    };
    const onChange = () => {
        if (readNativeFullscreenElement(fullscreenDocument) !== target) return;
        clearCanvasFullscreenFallback(target, fullscreenDocument);
    };

    lateNativeCleanupByTarget.set(target, stopWatching);
    fullscreenDocument.addEventListener('fullscreenchange', onChange);
    fullscreenDocument.addEventListener('webkitfullscreenchange', onChange);
    onChange();
};

export const clearCanvasFullscreenFallback = (
    target: HTMLElement,
    fullscreenDocument: WebKitFullscreenDocument = document,
): void => {
    lateNativeCleanupByTarget.get(target)?.();
    target.removeAttribute(CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE);
    restoreFallbackIsolation(target);

    const remainingFallback = fullscreenDocument.querySelector<HTMLElement>(
        `[${CANVAS_FULLSCREEN_FALLBACK_ATTRIBUTE}="${CANVAS_FULLSCREEN_FALLBACK_VALUE}"]`,
    );
    if (!remainingFallback) {
        fullscreenDocument.documentElement.classList.remove(CANVAS_FULLSCREEN_ROOT_CLASS);
    }
};

const isUnsupportedFullscreenError = (error: unknown): boolean => (
    typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'NotSupportedError'
);

const waitForNativeFullscreen = (
    target: HTMLElement,
    fullscreenDocument: WebKitFullscreenDocument,
    timeoutMs: number,
): Promise<boolean> => {
    if (readNativeFullscreenElement(fullscreenDocument) === target) {
        return Promise.resolve(true);
    }

    return new Promise((resolve) => {
        let settled = false;
        const finish = (entered: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            fullscreenDocument.removeEventListener('fullscreenchange', onChange);
            fullscreenDocument.removeEventListener('webkitfullscreenchange', onChange);
            resolve(entered);
        };
        const onChange = () => {
            if (readNativeFullscreenElement(fullscreenDocument) === target) {
                finish(true);
            }
        };
        const timeoutId = setTimeout(
            () => finish(readNativeFullscreenElement(fullscreenDocument) === target),
            Math.max(0, timeoutMs),
        );

        fullscreenDocument.addEventListener('fullscreenchange', onChange);
        fullscreenDocument.addEventListener('webkitfullscreenchange', onChange);
    });
};

const requestNativeFullscreen = (
    target: WebKitFullscreenElement,
): (() => Promise<void> | void) | null => {
    if (typeof target.requestFullscreen === 'function') {
        return () => target.requestFullscreen();
    }

    if (typeof target.webkitRequestFullscreen === 'function') {
        return () => target.webkitRequestFullscreen?.();
    }

    return null;
};

const exitNativeFullscreen = (
    fullscreenDocument: WebKitFullscreenDocument,
): (() => Promise<void> | void) | null => {
    if (typeof fullscreenDocument.exitFullscreen === 'function') {
        return () => fullscreenDocument.exitFullscreen();
    }

    if (typeof fullscreenDocument.webkitExitFullscreen === 'function') {
        return () => fullscreenDocument.webkitExitFullscreen?.();
    }

    return null;
};

export const enterCanvasFullscreen = async (
    target: HTMLElement,
    fullscreenDocument: WebKitFullscreenDocument = document,
    confirmationTimeoutMs: number = NATIVE_FULLSCREEN_CONFIRMATION_TIMEOUT_MS,
): Promise<boolean> => {
    if (!isFullscreenTargetConnected(target)) {
        throw new TypeError('The fullscreen target is not connected to the document.');
    }

    const requestFullscreen = requestNativeFullscreen(target);

    if (!requestFullscreen) {
        enableCanvasFullscreenFallback(target, fullscreenDocument);
        return true;
    }

    try {
        await requestFullscreen();
        if (!await waitForNativeFullscreen(
            target,
            fullscreenDocument,
            confirmationTimeoutMs,
        )) {
            if (!isFullscreenTargetConnected(target)) return false;

            enableCanvasFullscreenFallback(target, fullscreenDocument);
            watchForLateNativeFullscreen(target, fullscreenDocument);
        }
        return true;
    } catch (error) {
        if (!isUnsupportedFullscreenError(error)) throw error;

        enableCanvasFullscreenFallback(target, fullscreenDocument);
        return true;
    }
};

export const exitCanvasFullscreen = async (
    target: HTMLElement,
    fullscreenDocument: WebKitFullscreenDocument = document,
): Promise<boolean> => {
    if (isCanvasFullscreenFallback(target)) {
        clearCanvasFullscreenFallback(target, fullscreenDocument);
        return false;
    }

    if (readNativeFullscreenElement(fullscreenDocument) === target) {
        const exitFullscreen = exitNativeFullscreen(fullscreenDocument);
        if (!exitFullscreen) {
            throw new Error('The browser cannot exit its active fullscreen session.');
        }

        await exitFullscreen();
    }

    return false;
};

export const toggleCanvasFullscreen = async (
    target: HTMLElement,
    fullscreenDocument: WebKitFullscreenDocument = document,
    confirmationTimeoutMs: number = NATIVE_FULLSCREEN_CONFIRMATION_TIMEOUT_MS,
): Promise<boolean> => (
    isCanvasFullscreen(target, fullscreenDocument)
        ? exitCanvasFullscreen(target, fullscreenDocument)
        : enterCanvasFullscreen(target, fullscreenDocument, confirmationTimeoutMs)
);
