/** Owns the one decorative slider; dropdowns stay outside its clipped layer. */
export function trackNavigationIndicator(navigation: HTMLElement, track: HTMLElement, slider: HTMLElement): () => void {
    const document = navigation.ownerDocument;
    const view = document.defaultView;
    if (!view) return () => undefined;
    const links = [...navigation.querySelectorAll<HTMLElement>('.nav__list > .nav__item > .nav__link')];
    let hovered: HTMLElement | null = null;
    let frame: number | undefined;
    let stopped = false;

    function linkFor(element: Element | null): HTMLElement | null {
        const item = element?.closest<HTMLElement>('.nav__item');
        return item && navigation.contains(item) ? item.querySelector<HTMLElement>(':scope > .nav__link') : null;
    }

    function keyboardTarget(): HTMLElement | null {
        return document.activeElement?.matches(':focus-visible') ? linkFor(document.activeElement) : null;
    }

    function measure() {
        frame = undefined;
        if (stopped) return;
        const target = hovered ?? keyboardTarget() ?? links.find(link =>
            link.getAttribute('aria-current') === 'page' || link.classList.contains('nav__link--group-active'));
        if (!target) { track.dataset.visible = 'false'; return; }
        const bounds = track.getBoundingClientRect();
        const item = target.getBoundingClientRect();
        const left = Math.max(0, Math.min(bounds.width, item.left - bounds.left));
        const top = Math.max(0, Math.min(bounds.height, item.top - bounds.top));
        const right = Math.max(left, Math.min(bounds.width, item.right - bounds.left));
        const bottom = Math.max(top, Math.min(bounds.height, item.bottom - bounds.top));
        slider.style.setProperty('--nav-indicator-x', `${left}px`);
        slider.style.setProperty('--nav-indicator-y', `${top}px`);
        slider.style.setProperty('--nav-indicator-width', `${right - left}px`);
        slider.style.setProperty('--nav-indicator-height', `${bottom - top}px`);
        track.dataset.visible = right > left && bottom > top ? 'true' : 'false';
    }

    function refresh() {
        if (!stopped && frame === undefined) frame = view!.requestAnimationFrame(measure);
    }
    const pointerOver = (event: Event) => {
        hovered = linkFor(event.target instanceof Element ? event.target : null);
        refresh();
    };
    const pointerLeave = () => { hovered = null; refresh(); };
    const focusIn = () => { if (keyboardTarget()) hovered = null; refresh(); };
    const focusOut = () => { queueMicrotask(refresh); };
    navigation.addEventListener('pointerover', pointerOver);
    navigation.addEventListener('pointermove', pointerOver);
    navigation.addEventListener('pointerleave', pointerLeave);
    navigation.addEventListener('focusin', focusIn);
    navigation.addEventListener('focusout', focusOut);
    view.addEventListener('resize', refresh);
    view.addEventListener('scroll', refresh, true);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(refresh);
    observer?.observe(track);
    links.forEach(link => observer?.observe(link));
    void document.fonts?.ready.then(refresh);
    measure();

    return () => {
        stopped = true;
        if (frame !== undefined) view.cancelAnimationFrame(frame);
        observer?.disconnect();
        navigation.removeEventListener('pointerover', pointerOver);
        navigation.removeEventListener('pointermove', pointerOver);
        navigation.removeEventListener('pointerleave', pointerLeave);
        navigation.removeEventListener('focusin', focusIn);
        navigation.removeEventListener('focusout', focusOut);
        view.removeEventListener('resize', refresh);
        view.removeEventListener('scroll', refresh, true);
    };
}
