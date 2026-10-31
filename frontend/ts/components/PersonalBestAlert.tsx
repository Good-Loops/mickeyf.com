import { useEffect, type RefObject } from 'react';
import siteAlert from './siteAlert';
import { isCanvasFullscreen } from './fullscreenMode';

type PersonalBestAlertProps = {
    gameName: string;
    score: number;
    fullscreenTargetRef: RefObject<HTMLDivElement | null>;
    focusTargetRef?: RefObject<HTMLElement | null>;
    deferWhileOpenRef?: RefObject<HTMLDialogElement | null>;
};

/** Mount only for a server-confirmed personal best; each finished run owns its alert. */
export default function PersonalBestAlert({
    gameName,
    score,
    fullscreenTargetRef,
    focusTargetRef,
    deferWhileOpenRef,
}: PersonalBestAlertProps) {
    useEffect(() => {
        const frame = fullscreenTargetRef.current;
        if (!frame) return;
        let active = true;
        let popup: HTMLElement | null = null;
        let container: HTMLElement | null = null;
        const previousFocus = document.activeElement instanceof HTMLElement
            ? document.activeElement : null;
        const target = () => isCanvasFullscreen(frame) ? frame : document.body;
        const restoreFocus = () => {
            const element = focusTargetRef?.current ?? previousFocus;
            if (active && !siteAlert.isVisible() && element?.isConnected && !element.closest('[inert]')) {
                element.focus({ preventScroll: true });
            }
        };
        const reposition = () => {
            if (popup && siteAlert.getPopup() === popup && container?.isConnected && container.parentElement !== target()) {
                // Recreate through the library so modal aria-hidden/inert state
                // is recalculated; moving the old DOM can leave it inaccessible.
                show();
            }
        };
        const show = () => {
            if (!active) return;
            // Never wait for dismissal in a score-saving promise.
            void siteAlert.fire({
                target: target(),
                title: 'New personal best!',
                text: `${gameName} · ${score.toLocaleString('en-US')} points. Your record is saved.`,
                icon: 'success',
                confirmButtonText: 'Nice!',
                returnFocus: false,
                keydownListenerCapture: true,
            }).then(restoreFocus).catch(() => {
                // A presentation failure must not change the saved score's status.
            });
            popup = siteAlert.getPopup();
            container = siteAlert.getContainer();
        };

        // A score can finish saving while the player is reading the native help dialog.
        const blockingDialog = deferWhileOpenRef?.current;
        if (blockingDialog?.open) blockingDialog.addEventListener('close', show, { once: true });
        else show();
        document.addEventListener('fullscreenchange', reposition);
        document.addEventListener('webkitfullscreenchange', reposition);
        const observer = new MutationObserver(reposition);
        observer.observe(frame, { attributes: true, attributeFilter: ['data-canvas-fullscreen'] });

        return () => {
            active = false;
            blockingDialog?.removeEventListener('close', show);
            document.removeEventListener('fullscreenchange', reposition);
            document.removeEventListener('webkitfullscreenchange', reposition);
            observer.disconnect();
            if (popup && siteAlert.getPopup() === popup) siteAlert.close();
        };
    }, [gameName, score, fullscreenTargetRef, focusTargetRef, deferWhileOpenRef]);

    return null;
}
