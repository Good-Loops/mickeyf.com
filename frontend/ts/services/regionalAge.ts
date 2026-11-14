import { Capacitor, registerPlugin } from '@capacitor/core';
import { readNativeAgeRange } from './registrationAge.ts';

type RegionalStatus = 'not-required' | 'unsupported' | 'unavailable' | 'required';
export type RegionalAgeOutcome = 'continue' | 'shared' | 'unknown' | 'required-unavailable';
type RegionalAgePlugin = {
    checkRegionalAge(options: Record<string, never>): Promise<unknown>;
    requestAgeRange(options: Record<string, never>): Promise<unknown>;
};

function readRegionalStatus(value: unknown): RegionalStatus {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unavailable';
    const record = value as Record<string, unknown>;
    if (Object.keys(record).join(',') !== 'status') return 'unavailable';
    return record.status === 'required' || record.status === 'not-required' || record.status === 'unsupported'
        ? record.status : 'unavailable';
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Check only iOS's regulatory signal; no age data or device identifier is persisted. */
export async function checkRegionalAge({ isIos = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios',
    load = () => registerPlugin<RegionalAgePlugin>('LudolumeAge'),
    regionTimeoutMs = 10_000, promptTimeoutMs = 120_000 }: {
        isIos?: () => boolean; load?: () => RegionalAgePlugin;
        regionTimeoutMs?: number; promptTimeoutMs?: number;
    } = {}): Promise<RegionalAgeOutcome> {
    if (!isIos()) return 'continue';
    let plugin: RegionalAgePlugin;
    let region: RegionalStatus;
    try {
        plugin = load();
        region = readRegionalStatus(await bounded(plugin.checkRegionalAge({}), regionTimeoutMs));
    } catch { return 'unknown'; }
    if (region === 'not-required') return 'continue';
    if (region !== 'required') return 'unknown';
    try {
        const age = readNativeAgeRange(await bounded(plugin.requestAgeRange({}), promptTimeoutMs));
        return age.status === 'shared' ? 'shared' : 'required-unavailable';
    } catch { return 'required-unavailable'; }
}
