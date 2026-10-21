import type { RegistrationAgeBand } from './registrationApi.ts';

export type NativeAgeRange = Readonly<{
    status: 'shared' | 'not-shared' | 'verification-required' | 'unsupported' | 'unavailable';
    minimumAge: number | null;
    maximumAge: number | null;
}>;
type AgeSource = { request: () => Promise<unknown> } | null;
const unavailable: NativeAgeRange = { status: 'unavailable', minimumAge: null, maximumAge: null };
const parentKey = 'ludolume.parent-registration-until';
export const PARENT_RESTRICTION_MS = 24 * 60 * 60 * 1000;

/** Both native bridges normalize their upper bound to an inclusive age. */
export function readNativeAgeRange(value: unknown): NativeAgeRange {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable;
    const range = value as Record<string, unknown>;
    if (Object.keys(range).sort().join(',') !== 'maximumAge,minimumAge,status'
        || typeof range.status !== 'string'
        || !['shared', 'not-shared', 'verification-required', 'unsupported', 'unavailable'].includes(range.status)) return unavailable;
    const validAge = (age: unknown) => age === null || Number.isSafeInteger(age) && Number(age) >= 0 && Number(age) <= 150;
    if (!validAge(range.minimumAge) || !validAge(range.maximumAge)) return unavailable;
    if (range.status !== 'shared') return range.minimumAge === null && range.maximumAge === null ? range as NativeAgeRange : unavailable;
    if (range.minimumAge === null && range.maximumAge === null
        || range.minimumAge !== null && range.maximumAge !== null && Number(range.minimumAge) > Number(range.maximumAge)) return unavailable;
    return range as NativeAgeRange;
}

async function loadAgeSource(): Promise<AgeSource> {
    const { Capacitor, registerPlugin } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform()) return null;
    if (!['ios', 'android'].includes(Capacitor.getPlatform())) return { request: async () => unavailable };
    const plugin = registerPlugin<{ requestAgeRange(options: Record<string, never>): Promise<unknown> }>('LudolumeAge');
    // Never resolve a Capacitor proxy directly: its synthetic `then` method is not a Promise.
    return { request: () => plugin.requestAgeRange({}) };
}

export function createRegistrationAge({ load = loadAgeSource, storage = () => typeof window === 'undefined' ? null : window.sessionStorage,
    now = Date.now }: { load?: () => Promise<AgeSource>; storage?: () => Storage | null; now?: () => number } = {}) {
    let restrictedUntil = 0;
    function parentRequired(): boolean {
        if (restrictedUntil > now()) return true;
        try {
            const value = storage()?.getItem(parentKey);
            if (!value) return false;
            if (!/^[0-9]{13}$/u.test(value)) return true;
            const expiry = Number(value);
            if (expiry > now() + PARENT_RESTRICTION_MS) return true;
            if (expiry > now()) { restrictedUntil = expiry; return true; }
            storage()?.removeItem(parentKey);
            return false;
        } catch { return true; }
    }
    function rememberParent(): void {
        if (!parentRequired()) restrictedUntil = now() + PARENT_RESTRICTION_MS;
        try { if (restrictedUntil) storage()?.setItem(parentKey, String(restrictedUntil)); }
        catch { /* Keep the protective in-memory result if storage becomes unavailable. */ }
    }
    return {
        parentRequired,
        async check(selected: RegistrationAgeBand, parentRequiredBelow: number): Promise<RegistrationAgeBand | null> {
            if (parentRequired()) return 'parent-required';
            if (!Number.isInteger(parentRequiredBelow) || parentRequiredBelow < 1 || parentRequiredBelow > 18) return null;
            if (selected === 'parent-required') { rememberParent(); return selected; }
            try {
                const source = await load();
                if (!source) return parentRequired() ? 'parent-required' : selected; // Web retains its neutral age screen.
                const range = readNativeAgeRange(await source.request());
                if (parentRequired()) return 'parent-required';
                if (range.status !== 'shared') return null;
                const youngest = range.minimumAge ?? 0;
                const indicated = youngest < parentRequiredBelow ? 'parent-required' : youngest < 18 ? 'minor' : 'adult';
                const effective = indicated === 'parent-required' ? 'parent-required'
                    : indicated === 'minor' || selected === 'minor' ? 'minor' : 'adult';
                if (effective === 'parent-required') rememberParent();
                return effective;
            } catch { return null; }
        },
    };
}

export const registrationAge = createRegistrationAge();
