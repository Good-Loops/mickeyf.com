/** Move an input dialog only when the visible viewport no longer contains its input. */
export function keepDialogInputVisible(popup: HTMLElement, input: HTMLInputElement): () => void {
    const viewport = window.visualViewport;
    if (!viewport) return () => {};
    const originalTranslate = popup.style.translate;
    const originalMaxHeight = popup.style.maxHeight;
    let frame = 0;

    const adjust = () => {
        frame = 0;
        popup.style.translate = originalTranslate;
        popup.style.maxHeight = originalMaxHeight;
        if (document.activeElement !== input) return;
        const bottom = viewport.offsetTop + viewport.height;
        const overlap = input.getBoundingClientRect().bottom - bottom + 12;
        if (overlap <= 0) return;
        popup.style.maxHeight = `${Math.max(0, viewport.height - 24)}px`;
        const available = Math.max(0, popup.getBoundingClientRect().top - viewport.offsetTop - 12);
        const shift = Math.min(overlap, available);
        if (shift > 0) popup.style.translate = `0 -${shift}px`;
        if (overlap > shift) popup.scrollTop += overlap - shift;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(adjust); };
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    input.addEventListener('focus', schedule);
    input.addEventListener('blur', schedule);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
        if (frame) cancelAnimationFrame(frame);
        viewport.removeEventListener('resize', schedule);
        viewport.removeEventListener('scroll', schedule);
        input.removeEventListener('focus', schedule);
        input.removeEventListener('blur', schedule);
        window.removeEventListener('resize', schedule);
        popup.style.translate = originalTranslate;
        popup.style.maxHeight = originalMaxHeight;
    };
}
