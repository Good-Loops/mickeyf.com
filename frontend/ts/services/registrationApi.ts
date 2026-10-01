export type RegistrationAgeBand = 'parent-required' | 'minor' | 'adult';
export type RegistrationInput = Readonly<{ country: string; ageBand: RegistrationAgeBand; policyVersion: string }>;
export type RegistrationCountry = Readonly<{ country: string; parentRequiredBelow: number; adultFrom: 18 }>;
export type RegistrationConfig = Readonly<{ enabled: false }> | Readonly<{
    enabled: true; policyVersion: string; countries: readonly RegistrationCountry[]; parentRegistrationAvailable: false;
}>;
export type RegistrationResult = Readonly<{ authorized: true; expiresInSeconds: number; scoreVisibility: 'private' | 'public' }>
    | Readonly<{ error: string }>;

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const keys = (value: Record<string, unknown>, expected: string) => Object.keys(value).sort().join(',') === expected;

export function readRegistrationConfig(value: unknown): RegistrationConfig | null {
    if (!record(value)) return null;
    if (value.enabled === false && keys(value, 'enabled')) return { enabled: false };
    if (!keys(value, 'countries,enabled,parentRegistrationAvailable,policyVersion') || value.enabled !== true
        || value.parentRegistrationAvailable !== false || typeof value.policyVersion !== 'string'
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
    return { enabled: true, policyVersion: value.policyVersion, countries, parentRegistrationAvailable: false };
}

/** No browser storage, date of birth or credentials; authApi serializes cookie-changing calls. */
export function createRegistrationApi(apiBase: string, fetchRequest: typeof fetch = fetch) {
    return {
        async config(signal?: AbortSignal): Promise<RegistrationConfig | null> {
            try {
                const response = await fetchRequest(`${apiBase}/auth/registration/config`, { credentials: 'include', signal });
                return response.ok ? readRegistrationConfig(await response.json()) : null;
            } catch { return null; }
        },
        async begin(input: RegistrationInput): Promise<RegistrationResult> {
            try {
                const response = await fetchRequest(`${apiBase}/auth/registration/begin`, { method: 'POST', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ country: input.country, ageBand: input.ageBand, policyVersion: input.policyVersion }) });
                const result: unknown = await response.json();
                if (!record(result)) return { error: 'UNAVAILABLE' };
                if (response.status === 200 && keys(result, 'authorized,expiresInSeconds,scoreVisibility') && result.authorized === true
                    && Number.isInteger(result.expiresInSeconds) && Number(result.expiresInSeconds) > 0 && Number(result.expiresInSeconds) <= 300
                    && (result.scoreVisibility === 'private' || result.scoreVisibility === 'public')) return result as RegistrationResult;
                const statuses: Record<string, number> = { REGISTRATION_CLOSED: 503, INVALID_REGISTRATION: 400,
                    PARENT_REQUIRED: 403, INVALID_CONTEXT: 403, REGISTRATION_REQUIRED: 403, RATE_LIMITED: 429, UNAVAILABLE: 503 };
                if (keys(result, 'error') && typeof result.error === 'string' && Object.prototype.hasOwnProperty.call(statuses, result.error)
                    && statuses[result.error] === response.status) return { error: result.error };
            } catch { /* Uncertain delivery cannot authorize the credential form. */ }
            return { error: 'UNAVAILABLE' };
        },
        async cancel(): Promise<boolean> {
            try {
                const response = await fetchRequest(`${apiBase}/auth/registration/cancel`, { method: 'POST', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' }, body: '{}' });
                const result: unknown = await response.json();
                return response.status === 200 && record(result) && keys(result, 'cancelled') && result.cancelled === true;
            } catch { return false; }
        },
    };
}
