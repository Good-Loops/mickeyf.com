const INTERVAL_MS = 60_000;
const MAX_PASS_MS = 120_000;

type Options = { intervalMs?: number; maxPassMs?: number; now?: () => number; reportUnavailable?: () => void };

/** A local process owns this runner. Stopping the computer is not a production retention schedule. */
export function createLocalProviderMaintenance(run: () => Promise<number>, {
    intervalMs = INTERVAL_MS, maxPassMs = MAX_PASS_MS, now = Date.now,
    reportUnavailable = () => console.error(JSON.stringify({ component: 'local-provider-maintenance', status: 'unavailable' })),
}: Options = {}) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 3_600_000
        || !Number.isSafeInteger(maxPassMs) || maxPassMs < 1 || maxPassMs > MAX_PASS_MS) {
        throw new Error('Invalid local provider maintenance interval.');
    }
    let started = false;
    let stopped = false;
    let lastSuccess: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: Promise<void> | undefined;
    let readiness: Promise<void> | undefined;

    function pass(): Promise<void> {
        let expired = false;
        let settleReadiness!: () => void;
        readiness = new Promise<void>(resolve => { settleReadiness = resolve; });
        const deadline = setTimeout(() => {
            expired = true; lastSuccess = undefined; reportUnavailable(); settleReadiness();
        }, maxPassMs);
        const pending = Promise.resolve().then(run).then(code => {
            if (expired || stopped) return;
            if (code === 0) lastSuccess = now();
            else { lastSuccess = undefined; reportUnavailable(); }
        }).catch(() => {
            if (!expired && !stopped) { lastSuccess = undefined; reportUnavailable(); }
        }).finally(() => {
            clearTimeout(deadline);
            if (active === pending) active = undefined;
            settleReadiness();
            // An ambiguous timed-out pass keeps ownership until it settles. Never overlap or retry it.
            if (!stopped) { timer = setTimeout(() => { void pass(); }, intervalMs); timer.unref(); }
        });
        active = pending;
        return readiness;
    }

    return {
        start(): Promise<void> {
            if (stopped) return Promise.reject(new Error('Local provider maintenance has stopped.'));
            if (started) return readiness ?? Promise.resolve();
            started = true;
            return pass();
        },
        isHealthy(): boolean {
            return started && !stopped && lastSuccess !== undefined && now() >= lastSuccess
                && now() - lastSuccess <= intervalMs + maxPassMs;
        },
        async stop(): Promise<void> {
            stopped = true;
            if (timer !== undefined) clearTimeout(timer);
            await active;
        },
    };
}
