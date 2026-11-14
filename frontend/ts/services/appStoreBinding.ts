import { Capacitor } from '@capacitor/core';
import { readAppStoreTransaction, type AppStoreTransactionResult } from './appStoreTransaction.ts';
import { requestIsCurrent, type PageRequestInit } from './pageOwnership.ts';

export type AppStoreBindingResult = 'linked' | 'not-required' | 'unknown-age' | 'not-permitted' | 'unsupported' | 'unavailable' | 'cancelled';

/** Called only for an authenticated iOS session; the caller owns lifecycle and feature gating. */
export function createAppStoreBindingClient(apiBase: string, fetchRequest: typeof fetch, options: {
    isIos?: () => boolean;
    read?: () => Promise<AppStoreTransactionResult>;
} = {}) {
    const isIos = options.isIos ?? (() => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios');
    const read = options.read ?? readAppStoreTransaction;
    return async function bind({ signal, isCurrent }: { signal?: AbortSignal; isCurrent: () => boolean }): Promise<AppStoreBindingResult> {
        const current = () => !signal?.aborted && requestIsCurrent(isCurrent);
        if (!current()) return 'cancelled';
        try {
            if (!isIos()) return 'unsupported';
            const init = (body: object): PageRequestInit => ({ method: 'POST', credentials: 'include', signal,
                isCurrent: current, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const prepared = await fetchRequest(`${apiBase}/auth/app-store/transaction/prepare`, init({}));
            if (!current()) return 'cancelled';
            if (prepared.status === 204) return 'not-required';
            if (prepared.status === 409) return 'unknown-age';
            if (prepared.status === 403) return 'not-permitted';
            if (prepared.status !== 200) return 'unavailable';
            const value: unknown = await prepared.json();
            if (!value || typeof value !== 'object' || Array.isArray(value)
                || Object.keys(value).join(',') !== 'bindingProof'
                || typeof (value as Record<string, unknown>).bindingProof !== 'string'
                || !/^[A-Za-z0-9_-]{43}$/u.test((value as Record<string, unknown>).bindingProof as string)) return 'unavailable';
            if (!current()) return 'cancelled';
            const transaction = await read();
            if (!current()) return 'cancelled';
            if (transaction.kind !== 'available') return transaction.kind;
            const response = await fetchRequest(`${apiBase}/auth/app-store/transaction`, init({
                bindingProof: (value as Record<string, unknown>).bindingProof,
                signedTransaction: transaction.signedTransaction,
            }));
            if (!current()) return 'cancelled';
            if (response.status === 204) return 'linked';
            return response.status === 403 ? 'not-permitted' : 'unavailable';
        } catch { return current() ? 'unavailable' : 'cancelled'; }
    };
}
