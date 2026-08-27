export const THREE_BOSSES_RUN_SESSION_OBJECT = 'Three Bosses Run Session' as const;
const PAUSE_METHOD = 'PauseForDocumentHidden';
const RESUME_METHOD = 'ResumeFromDocumentHidden';

type UnityMainLoop = Readonly<{
    pauseMainLoop?: () => void;
    resumeMainLoop?: () => void;
}>;

export type UnityVisibilityBridgeInstance = Readonly<{
    Module?: UnityMainLoop;
    SendMessage?: (
        gameObjectName: string,
        methodName: string,
        parameter?: number | string,
    ) => void;
}>;

type VisibilityDocument = Readonly<{
    hidden: boolean;
    hasFocus: () => boolean;
    addEventListener: (type: 'visibilitychange', listener: EventListener) => void;
    removeEventListener: (type: 'visibilitychange', listener: EventListener) => void;
}>;

type VisibilityWindow = Readonly<{
    addEventListener: (type: 'blur' | 'focus', listener: EventListener) => void;
    removeEventListener: (type: 'blur' | 'focus', listener: EventListener) => void;
}>;

/**
 * Couples one Unity player to page visibility and top-level window focus for
 * exactly that player's lifetime. Unity owns timing/audio state while its
 * WebGL module owns the render loop, so both halves change in a deliberate
 * order.
 */
export const bindUnityVisibility = (
    instance: UnityVisibilityBridgeInstance,
    visibilityDocument: VisibilityDocument = document,
    visibilityWindow: VisibilityWindow = window,
): (() => void) => {
    const module = instance.Module;
    const sendMessage = instance.SendMessage;
    const pauseMainLoop = module?.pauseMainLoop;
    const resumeMainLoop = module?.resumeMainLoop;

    if (
        !module
        || typeof sendMessage !== 'function'
        || typeof pauseMainLoop !== 'function'
        || typeof resumeMainLoop !== 'function'
    ) {
        throw new Error(
            'The Unity WebGL player is missing the required background-pause API.',
        );
    }

    let disposed = false;
    let windowBlurred = !visibilityDocument.hasFocus();
    let receiverPaused = false;
    let mainLoopPaused = false;

    const pauseReceiver = () => {
        sendMessage.call(instance, THREE_BOSSES_RUN_SESSION_OBJECT, PAUSE_METHOD);
    };
    const resumeReceiver = () => {
        sendMessage.call(instance, THREE_BOSSES_RUN_SESSION_OBJECT, RESUME_METHOD);
    };

    const synchronize = () => {
        if (disposed) return;

        if (
            visibilityDocument.hidden
            || windowBlurred
            || !visibilityDocument.hasFocus()
        ) {
            if (!receiverPaused) {
                pauseReceiver();
                receiverPaused = true;
            }

            if (!mainLoopPaused) {
                try {
                    pauseMainLoop.call(module);
                    mainLoopPaused = true;
                } catch (error) {
                    try {
                        resumeReceiver();
                        receiverPaused = false;
                    } catch {
                        // Preserve the main-loop failure. A later visible event
                        // can retry the receiver cleanup independently.
                    }
                    throw error;
                }
            }

            return;
        }

        let receiverError: unknown;

        try {
            if (receiverPaused) {
                resumeReceiver();
                receiverPaused = false;
            }
        } catch (error) {
            receiverError = error;
        }

        try {
            if (mainLoopPaused) {
                resumeMainLoop.call(module);
                mainLoopPaused = false;
            }
        } catch (mainLoopError) {
            // A stuck browser loop is the more consequential failure. The
            // receiver remains independently retryable on the next event.
            throw mainLoopError;
        }

        if (receiverError) throw receiverError;
    };

    const onVisibilityChange: EventListener = () => synchronize();
    const onWindowBlur: EventListener = () => {
        windowBlurred = true;
        synchronize();
    };
    const onWindowFocus: EventListener = () => {
        windowBlurred = false;
        synchronize();
    };
    visibilityDocument.addEventListener('visibilitychange', onVisibilityChange);
    visibilityWindow.addEventListener('blur', onWindowBlur);
    visibilityWindow.addEventListener('focus', onWindowFocus);

    try {
        synchronize();
    } catch (error) {
        visibilityDocument.removeEventListener('visibilitychange', onVisibilityChange);
        visibilityWindow.removeEventListener('blur', onWindowBlur);
        visibilityWindow.removeEventListener('focus', onWindowFocus);
        disposed = true;
        throw error;
    }

    return () => {
        if (disposed) return;

        visibilityDocument.removeEventListener('visibilitychange', onVisibilityChange);
        visibilityWindow.removeEventListener('blur', onWindowBlur);
        visibilityWindow.removeEventListener('focus', onWindowFocus);
        disposed = true;

        try {
            if (receiverPaused) {
                try {
                    resumeReceiver();
                    receiverPaused = false;
                } catch {
                    // The player is being destroyed. Its receiver state can be
                    // discarded once the browser loop is resumed for Quit.
                }
            }
        } finally {
            if (mainLoopPaused) {
                resumeMainLoop.call(module);
                mainLoopPaused = false;
            }
        }
    };
};
