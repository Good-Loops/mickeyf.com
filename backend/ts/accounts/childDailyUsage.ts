/** A short foreground lease bounds over-counting after a lost connection. */
export const CHILD_USAGE_LEASE_MS = 30_000;
export const MAX_CHILD_DAILY_LIMIT_MS = 24 * 60 * 60_000;

export type ChildDailyUsagePolicy = Readonly<{ timeZone: string; dailyLimitMs: number }>;
export type ChildDailyUsageState = Readonly<{
    day: string;
    usedMs: number;
    accountedAtMs: number;
    activeUntilMs: number | null;
}>;
export type ChildDailyUsageResult = Readonly<{
    state: ChildDailyUsageState;
    remainingMs: number;
    allowedUntilMs: number | null;
}>;

function formatter(timeZone: string): Intl.DateTimeFormat {
    if (typeof timeZone !== 'string' || timeZone.length < 1 || timeZone.length > 100) throw new TypeError('Invalid time zone.');
    try {
        return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch { throw new TypeError('Invalid time zone.'); }
}

function dayAt(format: Intl.DateTimeFormat, instant: number): string {
    const parts = format.formatToParts(instant);
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value;
    const year = value('year'), month = value('month'), day = value('day');
    if (!year || !month || !day || !/^\d{4}$/u.test(year)) throw new TypeError('Invalid usage day.');
    return `${year}-${month}-${day}`;
}

/** First instant in the later local day, for an interval no longer than one lease. */
function dayBoundary(format: Intl.DateTimeFormat, start: number, end: number, earlierDay: string): number {
    let low = start, high = end;
    while (high - low > 1) {
        const middle = low + Math.floor((high - low) / 2);
        if (dayAt(format, middle) === earlierDay) low = middle;
        else high = middle;
    }
    return high;
}

/**
 * Settle the union of overlapping foreground leases using server time.
 * A heartbeat renews the lease; a parent read settles it without renewal.
 * Persistence must serialize updates for each child and use an authoritative
 * clock. This policy alone does not authenticate, store or enforce a limit.
 */
export function advanceChildDailyUsage(previous: ChildDailyUsageState | null, policy: ChildDailyUsagePolicy,
    nowMs: number, heartbeat: boolean): ChildDailyUsageResult {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || typeof heartbeat !== 'boolean'
        || !policy || !Number.isSafeInteger(policy.dailyLimitMs) || policy.dailyLimitMs < 60_000
        || policy.dailyLimitMs > MAX_CHILD_DAILY_LIMIT_MS) throw new TypeError('Invalid daily usage policy.');
    const format = formatter(policy.timeZone), today = dayAt(format, nowMs);
    let usedMs = 0;
    if (previous !== null) {
        if (!previous || !Number.isSafeInteger(previous.usedMs) || previous.usedMs < 0
            || previous.usedMs > MAX_CHILD_DAILY_LIMIT_MS || !Number.isSafeInteger(previous.accountedAtMs)
            || previous.accountedAtMs < 0 || previous.accountedAtMs > nowMs
            || previous.day !== dayAt(format, previous.accountedAtMs)
            || (previous.activeUntilMs !== null && (!Number.isSafeInteger(previous.activeUntilMs)
                || previous.activeUntilMs < previous.accountedAtMs
                || previous.activeUntilMs - previous.accountedAtMs > CHILD_USAGE_LEASE_MS))) {
            throw new TypeError('Invalid daily usage state.');
        }
        const end = previous.activeUntilMs === null ? previous.accountedAtMs : Math.min(nowMs, previous.activeUntilMs);
        const endDay = dayAt(format, end);
        if (endDay < previous.day || today < endDay) throw new TypeError('Usage day moved backwards.');
        if (endDay === previous.day) usedMs = previous.usedMs + (end - previous.accountedAtMs);
        else usedMs = end - dayBoundary(format, previous.accountedAtMs, end, previous.day);
        if (today !== endDay) usedMs = 0;
    }
    if (!Number.isSafeInteger(usedMs) || usedMs > MAX_CHILD_DAILY_LIMIT_MS) throw new TypeError('Invalid accumulated usage.');
    const remainingMs = Math.max(0, policy.dailyLimitMs - usedMs);
    const allowedUntilMs = heartbeat && remainingMs > 0 ? nowMs + Math.min(CHILD_USAGE_LEASE_MS, remainingMs) : null;
    // A parent read must not erase a still-valid lease issued to a child.
    const activeUntilMs = heartbeat ? allowedUntilMs
        : previous?.activeUntilMs !== null && previous?.activeUntilMs !== undefined && previous.activeUntilMs > nowMs
            ? previous.activeUntilMs : null;
    if (activeUntilMs !== null && !Number.isSafeInteger(activeUntilMs)) throw new TypeError('Invalid lease.');
    return {
        state: { day: today, usedMs, accountedAtMs: nowMs, activeUntilMs },
        remainingMs,
        allowedUntilMs,
    };
}
