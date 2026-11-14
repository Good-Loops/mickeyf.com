import { Capacitor, registerPlugin } from '@capacitor/core';

export type AppStoreTransactionResult =
    | { kind: 'available'; signedTransaction: string }
    | { kind: 'unsupported' }
    | { kind: 'unavailable' };

type AppStoreTransactionPlugin = { readSignedTransaction(options: Record<string, never>): Promise<unknown> };
const MAX_SIGNED_TRANSACTION_LENGTH = 65_536;

/** Read only on demand; this function neither stores nor sends the signed transaction. */
export async function readAppStoreTransaction({
    isIos = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios',
    load = () => registerPlugin<AppStoreTransactionPlugin>('LudolumeAppTransaction'),
    timeoutMs = 10_000,
}: {
    isIos?: () => boolean; load?: () => AppStoreTransactionPlugin; timeoutMs?: number;
} = {}): Promise<AppStoreTransactionResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        if (!isIos()) return { kind: 'unsupported' };
        const request = load().readSignedTransaction({});
        const response = await Promise.race([request, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
        if (!response || typeof response !== 'object' || Array.isArray(response)) return { kind: 'unavailable' };
        const record = response as Record<string, unknown>;
        if (Object.keys(record).length === 1 && record.status === 'unsupported') return { kind: 'unsupported' };
        if (Object.keys(record).sort().join(',') !== 'signedTransaction,status' || record.status !== 'available'
            || typeof record.signedTransaction !== 'string' || record.signedTransaction.length > MAX_SIGNED_TRANSACTION_LENGTH
            || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(record.signedTransaction)) {
            return { kind: 'unavailable' };
        }
        return { kind: 'available', signedTransaction: record.signedTransaction };
    } catch { return { kind: 'unavailable' }; }
    finally { if (timer !== undefined) clearTimeout(timer); }
}
