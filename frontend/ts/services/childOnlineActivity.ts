/** Only real foreground input can schedule a report; no timer or passive renewal does. */
export function watchChildOnlineActivity({ events, isVisible, canReport, report, now = () => performance.now() }: {
    events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
    isVisible: () => boolean;
    canReport: () => boolean;
    report: () => Promise<boolean | 'not-tracked'>;
    now?: () => number;
}): () => void {
    const types = ['pointerdown', 'pointermove', 'touchstart', 'keydown', 'wheel'];
    const options = { passive: true, capture: true };
    let nextAttempt = 0;
    let pending = false;
    let stopped = false;
    function onInput(event: Event): void {
        if (!event.isTrusted || stopped || pending || !isVisible() || !canReport() || now() < nextAttempt) return;
        pending = true;
        void Promise.resolve().then(async () => {
            if (stopped || !isVisible() || !canReport()) return false;
            return report();
        }).then(ok => { if (ok === 'not-tracked') stopped = true; else nextAttempt = now() + (ok ? 60 * 60_000 : 60_000); },
            () => { nextAttempt = now() + 60_000; }).finally(() => { pending = false; });
    }
    for (const type of types) events.addEventListener(type, onInput, options);
    return () => { stopped = true; for (const type of types) events.removeEventListener(type, onInput, options); };
}
