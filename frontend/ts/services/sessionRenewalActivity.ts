/** Activity, not an open tab or a timer, permits a session-renewal attempt. */
export const SESSION_RENEWAL_INTERVAL_MS = 15 * 60 * 1000;
export const SESSION_RENEWAL_RETRY_MS = 15 * 1000;

type RenewalActivityOptions = {
    windowEvents: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
    documentEvents: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
    isVisible: () => boolean;
    canRenew: () => boolean;
    renew: () => Promise<boolean>;
    now?: () => number;
};

export function watchSessionRenewalActivity({
    windowEvents, documentEvents, isVisible, canRenew, renew, now = () => performance.now(),
}: RenewalActivityOptions): { renewNow: () => Promise<void>; resetCooldown: () => void; stop: () => void } {
    let nextAttemptAt = now() + SESSION_RENEWAL_INTERVAL_MS;
    let pending = false;
    let recheckRequested = false;
    let stopped = false;

    async function attemptRenewal(): Promise<void> {
        if (stopped || pending) return;
        pending = true;
        nextAttemptAt = now() + SESSION_RENEWAL_INTERVAL_MS;
        try {
            if (!await renew()) nextAttemptAt = now() + SESSION_RENEWAL_RETRY_MS;
        } catch {
            nextAttemptAt = now() + SESSION_RENEWAL_RETRY_MS;
        } finally {
            pending = false;
            if (recheckRequested && !stopped) {
                recheckRequested = false;
                await attemptRenewal();
            }
        }
    }

    function onActivity(event: Event): void {
        if (!event.isTrusted || stopped || pending || !isVisible() || !canRenew()) return;
        if (now() < nextAttemptAt) return;
        // Retry failures on later activity while the server's predecessor grace is still open.
        void Promise.resolve().then(() => {
            if (!stopped && isVisible() && canRenew()) return attemptRenewal();
        });
    }

    const activityEvents = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'focus'];
    const options = { passive: true, capture: false };
    for (const eventName of activityEvents) windowEvents.addEventListener(eventName, onActivity, options);
    documentEvents.addEventListener('visibilitychange', onActivity);

    return {
        renewNow: () => {
            // A native revocation/resume signal must not vanish merely because
            // a check that started before that signal is still in flight.
            if (pending) { recheckRequested = true; return Promise.resolve(); }
            return attemptRenewal();
        },
        resetCooldown: () => { nextAttemptAt = now() + SESSION_RENEWAL_INTERVAL_MS; },
        stop: () => {
            stopped = true;
            for (const eventName of activityEvents) windowEvents.removeEventListener(eventName, onActivity, options);
            documentEvents.removeEventListener('visibilitychange', onActivity);
        },
    };
}
