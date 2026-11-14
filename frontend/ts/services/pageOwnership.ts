/** Match the router's page boundary; query and fragment changes keep the page. */
export function capturePageOwnership(): () => boolean {
    const path = typeof window === 'undefined' ? null : window.location.pathname;
    return () => (typeof window === 'undefined' ? null : window.location.pathname) === path;
}

/** Fail closed if a caller's ownership check fails. */
export function requestIsCurrent(isCurrent?: () => boolean): boolean {
    try { return isCurrent === undefined || isCurrent() === true; }
    catch { return false; }
}

/** Destructive approval binds the complete multiset, including duplicates. */
export function sameAccountIds(expected: readonly string[], actual: readonly string[]): boolean {
    if (expected.length !== actual.length) return false;
    const left = [...expected].sort(), right = [...actual].sort();
    return left.every((value, index) => value === right[index]);
}

/** Internal-only metadata: native transports check it immediately before dispatch. */
export type PageRequestInit = RequestInit & { isCurrent?: () => boolean };
