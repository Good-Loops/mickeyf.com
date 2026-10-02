import { useLayoutEffect, useRef, type RefObject } from 'react';
import { Capacitor } from '@capacitor/core';
import { useLocation } from 'react-router-dom';
import { createSafariBackgroundEdges, supportsSafariBackgroundEdges } from '../layout/safariBackgroundEdges';

/** One controller spans route changes so Safari never sees the inset torn down. */
export function useSafariBackgroundEdges(shell: RefObject<HTMLDivElement | null>): void {
    const location = useLocation();
    const controller = useRef<ReturnType<typeof createSafariBackgroundEdges> | null>(null);
    const appliedRoute = useRef(location.key);

    useLayoutEffect(() => {
        const standalone = window.matchMedia('(display-mode: standalone)').matches
            || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
        if (Capacitor.isNativePlatform() || !shell.current || !window.visualViewport
            || !supportsSafariBackgroundEdges(navigator.userAgent, standalone)) return;
        controller.current = createSafariBackgroundEdges(shell.current);
        return () => {
            controller.current?.dispose();
            controller.current = null;
        };
    }, [shell]);

    useLayoutEffect(() => {
        if (appliedRoute.current === location.key) return;
        appliedRoute.current = location.key;
        controller.current?.refresh();
    }, [location.key]);
}
