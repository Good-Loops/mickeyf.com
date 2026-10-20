import { isCanvasFullscreen } from '../../components/fullscreenMode.ts';

declare global {
    interface Window {
        MickeyfThreeBossesScrollPage?: (normalizedDelta: number) => void;
    }
}

/** Unity owns touch events; it forwards only drags that began outside interactive UI. */
export function bindUnityPageScroll(canvas: HTMLCanvasElement): () => void {
    const browser = canvas.ownerDocument.defaultView;
    const wrapper = canvas.closest<HTMLElement>('.three-bosses__canvas-wrapper');
    if (!browser || !wrapper) return () => {};

    const previous = browser.MickeyfThreeBossesScrollPage;
    const scrollPage = (normalizedDelta: number): void => {
        const page = canvas.ownerDocument;
        if (!canvas.isConnected || !Number.isFinite(normalizedDelta)
            || Math.abs(normalizedDelta) > 1 || isCanvasFullscreen(wrapper, page)) return;

        let remaining = normalizedDelta * canvas.getBoundingClientRect().height;
        if (!Number.isFinite(remaining)) return;

        // Follow the same scroll chain as a browser swipe (body can also overflow).
        for (let ancestor = canvas.parentElement; ancestor && ancestor !== page.documentElement;
            ancestor = ancestor.parentElement) {
            if (!/^(auto|scroll)$/.test(browser.getComputedStyle(ancestor).overflowY)) continue;
            const before = ancestor.scrollTop;
            const limit = Math.max(0, ancestor.scrollHeight - ancestor.clientHeight);
            ancestor.scrollTop = Math.min(limit, Math.max(0, before + remaining));
            remaining -= ancestor.scrollTop - before;
            if (Math.abs(remaining) < 0.5) return;
        }
        // The native shell locks the document while its main region still scrolls.
        // Respect that outer lock only after the inner scroll chain has consumed the drag.
        const overflow = browser.getComputedStyle(page.documentElement).overflowY;
        if (overflow === 'hidden' || overflow === 'clip') return;
        browser.scrollBy({ top: remaining, behavior: 'instant' });
    };
    browser.MickeyfThreeBossesScrollPage = scrollPage;

    return () => {
        if (browser.MickeyfThreeBossesScrollPage !== scrollPage) return;
        if (previous) browser.MickeyfThreeBossesScrollPage = previous;
        else delete browser.MickeyfThreeBossesScrollPage;
    };
}
