/** Draft client interpretation. The request start, not response arrival, bounds a lease. */
export type ChildUsageLease =
    | { kind: 'unrestricted' }
    | { kind: 'blocked'; remainingMs: number }
    | { kind: 'active'; remainingMs: number; deadline: number };

export function interpretChildUsageLease(value: unknown, requestStarted: number, received: number): ChildUsageLease {
    if (!Number.isFinite(requestStarted) || !Number.isFinite(received) || requestStarted < 0 || received < requestStarted
        || !value || typeof value !== 'object' || !('status' in value)) throw new TypeError('Invalid usage response.');
    if (value.status === 'not-managed' || value.status === 'not-configured') return { kind: 'unrestricted' };
    if (value.status !== 'configured' || !('allowedForMs' in value) || !('remainingMs' in value)
        || !Number.isSafeInteger(value.allowedForMs) || Number(value.allowedForMs) < 0 || Number(value.allowedForMs) > 30_000
        || !Number.isSafeInteger(value.remainingMs) || Number(value.remainingMs) < 0 || Number(value.remainingMs) > 86_400_000
        || Number(value.allowedForMs) > Number(value.remainingMs)) throw new TypeError('Invalid usage response.');
    const deadline = requestStarted + Number(value.allowedForMs), remainingMs = Number(value.remainingMs);
    if (!Number.isFinite(deadline)) throw new TypeError('Invalid usage deadline.');
    if (deadline <= received) return { kind: 'blocked', remainingMs };
    return { kind: 'active', remainingMs, deadline };
}
