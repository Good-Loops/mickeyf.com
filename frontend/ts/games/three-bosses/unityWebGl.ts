import {
    isThreeBossesReleaseEnabled,
    THREE_BOSSES_BUILD_BASE_PATH,
} from '@/config/featureFlags';
import {
    bindUnityVisibility,
    type UnityVisibilityBridgeInstance,
} from '@/games/three-bosses/unityVisibility';
import {
    bindThreeBossesSubmissionBridge,
    configureThreeBossesSubmission,
    type ThreeBossesRunSubmitter,
} from '@/games/three-bosses/unitySubmissionBridge';

type UnityWebGlInstance = UnityVisibilityBridgeInstance & Readonly<{
    Quit: () => Promise<void>;
    SetFullscreen?: (fullscreen: number) => void;
}>;

type CreateUnityInstance = (
    canvas: HTMLCanvasElement,
    config: UnityWebGlConfig,
    onProgress: (progress: number) => void,
) => Promise<UnityWebGlInstance>;

type UnityWebGlConfig = Readonly<{
    dataUrl: string;
    frameworkUrl: string;
    codeUrl: string;
    streamingAssetsUrl: string;
    companyName: string;
    productName: string;
    productVersion: string;
    cacheControl: (url: string) => string;
}>;

type UnityWebGlManifest = Readonly<{
    loaderUrl: string;
    dataUrl: string;
    frameworkUrl: string;
    codeUrl: string;
    streamingAssetsUrl?: string;
    companyName?: string;
    productName?: string;
    productVersion?: string;
}>;

declare global {
    interface Window {
        createUnityInstance?: CreateUnityInstance;
    }
}

export type UnityWebGlHandle = Readonly<{
    quit: () => Promise<void>;
    setSubmissionEnabled: (enabled: boolean) => void;
}>;

type StartUnityWebGlOptions = Readonly<{
    canvas: HTMLCanvasElement;
    signal: AbortSignal;
    onProgress: (progress: number) => void;
    submitRun: ThreeBossesRunSubmitter;
}>;

const manifestUrl = `${THREE_BOSSES_BUILD_BASE_PATH}build-manifest.json`;
let activeHandlePromise: Promise<UnityWebGlHandle> | null = null;

const requireString = (
    manifest: Record<string, unknown>,
    field: keyof UnityWebGlManifest,
): string => {
    const value = manifest[field];

    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`The WebGL manifest is missing ${field}.`);
    }

    return value;
};

const resolveAssetUrl = (value: string): string => {
    const resolved = new URL(value, new URL(THREE_BOSSES_BUILD_BASE_PATH, window.location.origin));

    if (
        resolved.origin !== window.location.origin
        || !resolved.pathname.startsWith(THREE_BOSSES_BUILD_BASE_PATH)
    ) {
        throw new Error('The WebGL manifest referenced an asset outside its allowed path.');
    }

    return resolved.href;
};

const readManifest = async (signal: AbortSignal): Promise<UnityWebGlManifest> => {
    let response: Response;

    try {
        response = await fetch(manifestUrl, { cache: 'no-store', signal });
    } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(
            isThreeBossesReleaseEnabled
                ? 'The Three Bosses game assets are temporarily unavailable.'
                : 'The local Three Bosses WebGL server is unavailable. Start it and rebuild the game if needed.',
        );
    }

    if (response.status === 500) {
        // Vite's local proxy converts an unavailable asset server into an
        // empty HTTP 500 response, so surface the same actionable message as
        // a direct network failure.
        throw new Error(
            isThreeBossesReleaseEnabled
                ? 'The Three Bosses game assets are temporarily unavailable.'
                : 'The local Three Bosses WebGL server is unavailable. Start it and rebuild the game if needed.',
        );
    }

    if (!response.ok) {
        throw new Error(
            isThreeBossesReleaseEnabled
                ? `The Three Bosses game assets are unavailable (HTTP ${response.status}).`
                : `The local Three Bosses WebGL build is unavailable (HTTP ${response.status}).`,
        );
    }

    const raw = await response.json() as Record<string, unknown>;

    return {
        loaderUrl: requireString(raw, 'loaderUrl'),
        dataUrl: requireString(raw, 'dataUrl'),
        frameworkUrl: requireString(raw, 'frameworkUrl'),
        codeUrl: requireString(raw, 'codeUrl'),
        streamingAssetsUrl:
            typeof raw.streamingAssetsUrl === 'string'
                ? raw.streamingAssetsUrl
                : 'StreamingAssets',
        companyName: typeof raw.companyName === 'string' ? raw.companyName : 'DefaultCompany',
        productName: typeof raw.productName === 'string' ? raw.productName : 'Three Bosses',
        productVersion: typeof raw.productVersion === 'string' ? raw.productVersion : '1.0',
    };
};

const loadUnityFactory = async (
    loaderUrl: string,
    signal: AbortSignal,
): Promise<{ createUnityInstance: CreateUnityInstance; script: HTMLScriptElement }> => {
    if (signal.aborted) {
        throw new DOMException('The WebGL load was cancelled.', 'AbortError');
    }

    const script = document.createElement('script');
    script.src = loaderUrl;
    script.async = true;
    script.dataset.threeBossesUnityLoader = 'true';

    await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            script.remove();
            reject(new DOMException('The WebGL load was cancelled.', 'AbortError'));
        };

        signal.addEventListener('abort', onAbort, { once: true });
        script.addEventListener('load', () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, { once: true });
        script.addEventListener('error', () => {
            signal.removeEventListener('abort', onAbort);
            script.remove();
            reject(new Error('The Unity WebGL loader script could not be loaded.'));
        }, { once: true });
        document.head.append(script);
    });

    if (typeof window.createUnityInstance !== 'function') {
        script.remove();
        throw new Error('The Unity WebGL loader did not expose createUnityInstance.');
    }

    return { createUnityInstance: window.createUnityInstance, script };
};

const clearUnityFactory = (factory: CreateUnityInstance): void => {
    if (window.createUnityInstance !== factory) return;

    // Unity declares this browser global with `var`, making the property
    // non-configurable. It is writable, so clear the value instead of deleting
    // the property; the next loader script can then assign a fresh factory.
    try {
        window.createUnityInstance = undefined;
    } catch {
        // Removing the script and quitting the instance still release the
        // player. A future loader assignment can replace the same global.
    }
};

const startNewHandle = async ({
    canvas,
    signal,
    onProgress,
    submitRun,
}: StartUnityWebGlOptions): Promise<UnityWebGlHandle> => {
    const manifest = await readManifest(signal);
    const loaderUrl = resolveAssetUrl(manifest.loaderUrl);
    const { createUnityInstance, script } = await loadUnityFactory(loaderUrl, signal);
    let quitPromise: Promise<void> | null = null;

    try {
        const instance = await createUnityInstance(canvas, {
            dataUrl: resolveAssetUrl(manifest.dataUrl),
            frameworkUrl: resolveAssetUrl(manifest.frameworkUrl),
            codeUrl: resolveAssetUrl(manifest.codeUrl),
            streamingAssetsUrl: resolveAssetUrl(manifest.streamingAssetsUrl ?? 'StreamingAssets'),
            companyName: manifest.companyName ?? 'DefaultCompany',
            productName: manifest.productName ?? 'Three Bosses',
            productVersion: manifest.productVersion ?? '1.0',
            cacheControl: (assetUrl) => {
                if (!isThreeBossesReleaseEnabled) return 'no-store';

                const pathname = new URL(assetUrl, window.location.origin).pathname;
                return pathname.startsWith(`${THREE_BOSSES_BUILD_BASE_PATH}releases/`)
                    ? 'immutable'
                    : 'no-store';
            },
        }, onProgress);

        let releaseVisibility: (() => void) | null = null;
        let releaseSubmissionBridge: (() => void) | null = null;
        let browserBindingsReleased = false;

        try {
            releaseVisibility = bindUnityVisibility(instance);
            releaseSubmissionBridge = bindThreeBossesSubmissionBridge(instance, submitRun);
            configureThreeBossesSubmission(instance, false);
        } catch (error) {
            try {
                releaseSubmissionBridge?.();
            } catch {
                // Continue tearing down the partially initialized player.
            }
            try {
                releaseVisibility?.();
            } catch {
                // Quit remains authoritative for partial initialization.
            }
            await instance.Quit();
            throw error;
        }

        const releaseBrowserBindings = () => {
            if (browserBindingsReleased) return;
            browserBindingsReleased = true;

            try {
                configureThreeBossesSubmission(instance, false);
            } catch {
                // The player may already be shutting down.
            }
            try {
                releaseSubmissionBridge?.();
            } catch {
                // Quit remains authoritative if a browser-global cleanup fails.
            }
            try {
                releaseVisibility?.();
            } catch {
                // A hidden player is resumed again by the shutdown path below.
            }
        };

        const quit = async () => {
            if (quitPromise) return quitPromise;

            quitPromise = (async () => {
                try {
                    releaseBrowserBindings();

                    // A hidden player must resume its main loop before Quit can
                    // observe Unity's shutdown request.
                    await instance.Quit();
                } finally {
                    script.remove();
                    clearUnityFactory(createUnityInstance);
                }
            })();

            return quitPromise;
        };

        if (signal.aborted) {
            await quit();
            throw new DOMException('The WebGL load was cancelled.', 'AbortError');
        }

        return {
            quit,
            setSubmissionEnabled: (enabled: boolean) => {
                if (browserBindingsReleased) return;
                configureThreeBossesSubmission(instance, enabled);
            },
        };
    } catch (error) {
        script.remove();
        clearUnityFactory(createUnityInstance);
        throw error;
    }
};

/**
 * Starts the singleton Unity player. A new route mount waits for any
 * previous instance to quit before creating another one.
 */
export const startThreeBossesWebGl = async (
    options: StartUnityWebGlOptions,
): Promise<UnityWebGlHandle> => {
    if (activeHandlePromise) {
        let activeHandle: UnityWebGlHandle | null = null;

        try {
            activeHandle = await activeHandlePromise;
        } catch {
            // A failed or cancelled prior load owns no live Unity instance.
            activeHandlePromise = null;
        }

        if (activeHandle) {
            // Do not create a second player if the old one cannot quit. Keeping
            // the active promise lets a later attempt retry the same cleanup.
            await activeHandle.quit();
        }
    }

    const nextHandlePromise = startNewHandle(options);
    activeHandlePromise = nextHandlePromise;

    try {
        const handle = await nextHandlePromise;

        return {
            setSubmissionEnabled: handle.setSubmissionEnabled,
            quit: async () => {
                await handle.quit();
                if (activeHandlePromise === nextHandlePromise) {
                    activeHandlePromise = null;
                }
            },
        };
    } catch (error) {
        if (activeHandlePromise === nextHandlePromise) {
            activeHandlePromise = null;
        }
        throw error;
    }
};
