/**
 * Fullscreen toggle button.
 * Bridges native fullscreen and the iPhone viewport fallback into one control.
 * Subscribes to fullscreen and keyboard events and unregisters on unmount.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
    clearCanvasFullscreenFallback,
    isCanvasFullscreen,
    isCanvasFullscreenFallback,
    toggleCanvasFullscreen,
} from '@/components/fullscreenMode';

interface FullscreenButtonProps {
    targetRef?: React.RefObject<HTMLElement | HTMLDivElement | null>;
    focusRef?: React.RefObject<HTMLElement | null>;
    className?: string;
    label?: string;
}

const FullscreenEnterIcon: React.FC = () => (
    <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        width="100%"
        height="100%"
    >
        <path
            d="M4 9V4h5
               M4 15v5h5
               M20 9V4h-5
               M20 15v5h-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    </svg>
);

const FullscreenExitIcon: React.FC = () => (
    <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        width="100%"
        height="100%"
    >
        <path
            d="
                M5 9 H9 V5
                M5 15 H9 V19
                M19 9 H15 V5
                M19 15 H15 V19
            "
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    </svg>
);


const FullscreenButton: React.FC<FullscreenButtonProps> = ({
    targetRef,
    focusRef,
    className = "",
    label,
}) => {
    const [isFullscreen, setIsFullscreen] = useState(false);
    const focusRestorationRef = useRef<{ previousElement: HTMLElement | null } | null>(null);
    const transitionVersionRef = useRef(0);

    const restorePreviousFocus = useCallback(() => {
        const restoration = focusRestorationRef.current;
        if (!restoration) return;
        // Native events and the awaited exit can both finish the same transition.
        focusRestorationRef.current = null;
        const previousFocus = restoration.previousElement;

        if (previousFocus?.isConnected) {
            previousFocus.focus({ preventScroll: true });
            return;
        }

        focusRef?.current?.focus({ preventScroll: true });
    }, [focusRef]);

    const toggle = useCallback(async () => {
        const target = targetRef?.current ?? document.documentElement;
        if (!target) return;
        const version = ++transitionVersionRef.current;

        try {
            const wasFullscreen = isCanvasFullscreen(target);
            if (!wasFullscreen) {
                focusRestorationRef.current = {
                    previousElement: document.activeElement instanceof HTMLElement
                        ? document.activeElement
                        : null,
                };
            }

            const nextFullscreen = await toggleCanvasFullscreen(target);
            if (version !== transitionVersionRef.current || !target.isConnected) return;
            setIsFullscreen(nextFullscreen);
            if (nextFullscreen) focusRef?.current?.focus({ preventScroll: true });
            else restorePreviousFocus();
        } catch (error) {
            // Browsers can deny fullscreen when the click is not considered a
            // direct user gesture. Leave the control retryable and avoid an
            // unhandled rejection disrupting the page.
            console.warn("Fullscreen request was denied.", error);
        }
    }, [targetRef, focusRef, restorePreviousFocus]);

    useEffect(() => {
        const target = targetRef?.current ?? document.documentElement;

        const update = () => {
            const nextFullscreen = isCanvasFullscreen(target);
            setIsFullscreen(nextFullscreen);
            if (!nextFullscreen) restorePreviousFocus();
        };

        const exitFallbackWithEscape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || !isCanvasFullscreenFallback(target)) return;

            event.preventDefault();
            void toggle();
        };

        // Must unregister on unmount to prevent leaked listeners.
        document.addEventListener("fullscreenchange", update);
        document.addEventListener("webkitfullscreenchange", update);
        document.addEventListener('keydown', exitFallbackWithEscape);

        return () => {
            transitionVersionRef.current += 1;
            document.removeEventListener("fullscreenchange", update);
            document.removeEventListener("webkitfullscreenchange", update);
            document.removeEventListener('keydown', exitFallbackWithEscape);
            clearCanvasFullscreenFallback(target);
            restorePreviousFocus();
        };
    }, [restorePreviousFocus, targetRef, toggle]);

    return (
        <button
            type="button"
            className={`fullscreen-btn ${className ?? ""}`}
            onClick={toggle}
            aria-label={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
        >
            {label ?? (isFullscreen ? <FullscreenExitIcon /> : <FullscreenEnterIcon />)}
        </button>
    );
};

export default FullscreenButton;
