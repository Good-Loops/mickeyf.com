export type RegistrationAgeBand = 'parent-required' | 'minor' | 'adult';
export type RegistrationInput = Readonly<{ policyVersion: string }> | Readonly<{ country: string; ageBand: RegistrationAgeBand; policyVersion: string }>;
export type RegistrationCountry = Readonly<{ country: string; parentRequiredBelow: number; adultFrom: 18 }>;
export type RegistrationConfig = Readonly<{ enabled: false }> | Readonly<{
    enabled: true; policyVersion: string; countries: readonly RegistrationCountry[]; parentRegistrationAvailable: false;
}> | Readonly<{
    enabled: true; audience: 'children-included'; creationEnabled: boolean; policyVersion: string;
    countries: readonly RegistrationCountry[]; parentRegistrationAvailable: boolean;
}> | Readonly<{
    enabled: true; mode: 'general-audience'; policyVersion: string; optionalDetails: false; parentRegistrationAvailable: false;
}>;
export type RegistrationResult = Readonly<{ authorized: true; expiresInSeconds: number; scoreVisibility: 'private' | 'public' }>
    | Readonly<{ error: string }>;

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const keys = (value: Record<string, unknown>, expected: string) => Object.keys(value).sort().join(',') === expected;

export function supportsChildAudience(value: RegistrationConfig | null): value is Extract<RegistrationConfig, { audience: 'children-included' }> {
    return value?.enabled === true && 'audience' in value && value.audience === 'children-included';
}

export function readRegistrationConfig(value: unknown): RegistrationConfig | null {
    if (!record(value)) return null;
    if (value.enabled === false && keys(value, 'enabled')) return { enabled: false };
    if (value.enabled === true && value.mode === 'general-audience'
        && keys(value, 'enabled,mode,optionalDetails,parentRegistrationAvailable,policyVersion')
        && value.optionalDetails === false && value.parentRegistrationAvailable === false
        && typeof value.policyVersion === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(value.policyVersion)) {
        return { enabled: true, mode: 'general-audience', policyVersion: value.policyVersion,
            optionalDetails: false, parentRegistrationAvailable: false };
    }
    const childAudience = value.audience === 'children-included'
        && keys(value, 'audience,countries,creationEnabled,enabled,parentRegistrationAvailable,policyVersion')
        && typeof value.creationEnabled === 'boolean'
        && typeof value.parentRegistrationAvailable === 'boolean';
    const legacyStaged = keys(value, 'countries,enabled,parentRegistrationAvailable,policyVersion')
        && value.parentRegistrationAvailable === false;
    if ((!childAudience && !legacyStaged) || value.enabled !== true || typeof value.policyVersion !== 'string'
        || !/^[A-Za-z0-9._-]{1,64}$/u.test(value.policyVersion) || !Array.isArray(value.countries)
        || value.countries.length < 1 || value.countries.length > 249) return null;
    const seen = new Set<string>();
    const countries: RegistrationCountry[] = [];
    for (const item of value.countries) {
        if (!record(item) || !keys(item, 'adultFrom,country,parentRequiredBelow') || typeof item.country !== 'string'
            || !/^[A-Z]{2}$/u.test(item.country) || seen.has(item.country) || item.adultFrom !== 18
            || !Number.isInteger(item.parentRequiredBelow) || Number(item.parentRequiredBelow) < 1
            || Number(item.parentRequiredBelow) > 18) return null;
        seen.add(item.country);
        countries.push({ country: item.country, parentRequiredBelow: Number(item.parentRequiredBelow), adultFrom: 18 });
    }
    return childAudience
        ? { enabled: true, audience: 'children-included', creationEnabled: value.creationEnabled as boolean, policyVersion: value.policyVersion, countries,
            parentRegistrationAvailable: value.parentRegistrationAvailable as boolean }
        : { enabled: true, policyVersion: value.policyVersion, countries, parentRegistrationAvailable: false };
}

/** No browser storage or credentials; the explicit server policy selects the anonymous grant contract. */
export function createRegistrationApi(apiBase: string, fetchRequest: typeof fetch = fetch,
    options: { requireChildAudience?: boolean; alreadyLocked?: boolean; timeoutMs?: number } = {}) {
    async function requestJson(url: string, init: RequestInit) {
        if (!options.requireChildAudience) {
            const response = await fetchRequest(url, init);
            return { response, result: await response.json() as unknown };
        }
        const controller = new AbortController();
        const outer = init.signal;
        const abort = () => controller.abort();
        if (outer?.aborted) throw new DOMException('Aborted', 'AbortError');
        outer?.addEventListener('abort', abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const timeout = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new Error('Request timed out')); }, options.timeoutMs ?? 15_000);
            });
            return await Promise.race([timeout, (async () => {
                const response = await fetchRequest(url, { ...init, signal: controller.signal });
                return { response, result: await response.json() as unknown };
            })()]);
        } finally { if (timer) clearTimeout(timer); outer?.removeEventListener('abort', abort); }
    }
    return {
        async config(signal?: AbortSignal): Promise<RegistrationConfig | null> {
            try {
                const { response, result } = await requestJson(`${apiBase}/auth/registration/config`, { credentials: 'include', signal });
                const policy = response.ok ? readRegistrationConfig(result) : null;
                return options.requireChildAudience && policy?.enabled && !supportsChildAudience(policy) ? null : policy;
            } catch { return null; }
        },
        async begin(input: RegistrationInput): Promise<RegistrationResult> {
            if (options.requireChildAudience && !('country' in input)) {
                return { error: 'REGISTRATION_REQUIRED' };
            }
            try {
                const send = async (): Promise<RegistrationResult> => {
                if (options.requireChildAudience) {
                    const { response: boot, result } = await requestJson(`${apiBase}/auth/registration/bootstrap`, { method: 'POST', credentials: 'include',
                        headers: { 'Content-Type': 'application/json' }, body: '{}' });
                    if (!boot.ok || !record(result) || !keys(result, 'ready') || result.ready !== true) return { error: 'UNAVAILABLE' };
                }
                const { response, result } = await requestJson(`${apiBase}/auth/registration/begin`, { method: 'POST', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify('country' in input
                        ? { country: input.country, ageBand: input.ageBand, policyVersion: input.policyVersion }
                        : { policyVersion: input.policyVersion }) });
                if (!record(result)) return { error: 'UNAVAILABLE' };
                if (response.status === 200 && keys(result, 'authorized,expiresInSeconds,scoreVisibility') && result.authorized === true
                    && (!('country' in input) || input.ageBand !== 'parent-required')
                    && Number.isInteger(result.expiresInSeconds) && Number(result.expiresInSeconds) > 0 && Number(result.expiresInSeconds) <= 300
                    && (result.scoreVisibility === 'private' || !options.requireChildAudience && result.scoreVisibility === 'public')) return result as RegistrationResult;
                const statuses: Record<string, number> = { REGISTRATION_CLOSED: 503, INVALID_REGISTRATION: 400,
                    PARENT_REQUIRED: 403, INVALID_CONTEXT: 403, REGISTRATION_REQUIRED: 403, RATE_LIMITED: 429, UNAVAILABLE: 503 };
                if (keys(result, 'error') && typeof result.error === 'string' && Object.prototype.hasOwnProperty.call(statuses, result.error)
                    && statuses[result.error] === response.status) return { error: result.error };
                return { error: 'UNAVAILABLE' };
                };
                if (!options.requireChildAudience) return await send();
                // Establish the cookie once across tabs before observing any age.
                if (typeof navigator === 'undefined' || !navigator.locks?.request) return { error: 'UNAVAILABLE' };
                if (options.alreadyLocked) return await send();
                return await navigator.locks.request('ludolume-auth-cookie-v1', { mode: 'exclusive' }, send);
            } catch { /* Uncertain delivery cannot authorize the credential form. */ }
            return { error: 'UNAVAILABLE' };
        },
        async beginNativeAgeCheck(): Promise<string | null> {
            if (!options.requireChildAudience || typeof navigator === 'undefined' || !navigator.locks?.request) return null;
            const run = async (): Promise<string | null> => {
                const init = { method: 'POST', credentials: 'include' as const,
                    headers: { 'Content-Type': 'application/json' }, body: '{}' };
                const { response: boot, result: ready } = await requestJson(`${apiBase}/auth/registration/bootstrap`, init);
                if (!boot.ok || !record(ready) || !keys(ready, 'ready') || ready.ready !== true) return null;
                const { response, result } = await requestJson(`${apiBase}/auth/registration/age-check/start`, init);
                return response.ok && record(result) && keys(result, 'attempt') && typeof result.attempt === 'string'
                    && /^[A-Za-z0-9_-]{43}$/u.test(result.attempt) ? result.attempt : null;
            };
            try { return options.alreadyLocked ? await run()
                : await navigator.locks.request('ludolume-auth-cookie-v1', { mode: 'exclusive' }, run); }
            catch { return null; }
        },
        async finishNativeAgeCheck(input: Readonly<{ attempt: string; country: string;
            ageBand: 'adult' | 'minor' | 'parent-required'; policyVersion: string }>): Promise<boolean> {
            if (!options.requireChildAudience || typeof navigator === 'undefined' || !navigator.locks?.request
                || !/^[A-Za-z0-9_-]{43}$/u.test(input.attempt)) return false;
            const run = async (): Promise<boolean> => {
                const { response, result } = await requestJson(`${apiBase}/auth/registration/age-check/finish`, {
                    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ attempt: input.attempt, country: input.country, ageBand: input.ageBand, policyVersion: input.policyVersion }) });
                return response.ok && record(result) && keys(result, 'observed') && result.observed === true;
            };
            try { return options.alreadyLocked ? await run()
                : await navigator.locks.request('ludolume-auth-cookie-v1', { mode: 'exclusive' }, run); }
            catch { return false; }
        },
        async observe(input: Readonly<{ country: string; ageBand: 'minor' | 'parent-required'; policyVersion: string }>): Promise<boolean> {
            if (!options.requireChildAudience || typeof navigator === 'undefined' || !navigator.locks?.request
                || !['minor', 'parent-required'].includes(input.ageBand)) return false;
            const send = async (): Promise<boolean> => {
                const init = { method: 'POST', credentials: 'include' as const,
                    headers: { 'Content-Type': 'application/json' } };
                const { response: boot, result: ready } = await requestJson(`${apiBase}/auth/registration/bootstrap`, { ...init, body: '{}' });
                if (!boot.ok || !record(ready) || !keys(ready, 'ready') || ready.ready !== true) return false;
                const { response: observed, result } = await requestJson(`${apiBase}/auth/registration/observe`, { ...init,
                    body: JSON.stringify({ country: input.country, ageBand: input.ageBand, policyVersion: input.policyVersion }) });
                return observed.ok && record(result) && keys(result, 'observed') && result.observed === true;
            };
            try { return options.alreadyLocked ? await send()
                : await navigator.locks.request('ludolume-auth-cookie-v1', { mode: 'exclusive' }, send); }
            catch { return false; }
        },
        async cancel(): Promise<boolean> {
            try {
                const { response, result } = await requestJson(`${apiBase}/auth/registration/cancel`, { method: 'POST', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' }, body: '{}' });
                return response.status === 200 && record(result) && keys(result, 'cancelled') && result.cancelled === true;
            } catch { return false; }
        },
    };
}
