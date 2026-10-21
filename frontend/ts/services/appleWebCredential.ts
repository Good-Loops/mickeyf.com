import type { AppleProviderCredential, ProviderAuthenticationChallenge } from './authApi.ts';

export type AppleWebIdentity = { auth: {
    init(options: { clientId: string; redirectURI: string; scope: 'email'; state: string; nonce: string; usePopup: true }): void;
    signIn(): Promise<unknown>;
} };
type Dependencies = {
    document: Pick<Document, 'createElement' | 'head'>;
    apple(): AppleWebIdentity | undefined;
    hasUserActivation?(): boolean;
};
const SCRIPT = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
const failure = (code: 'CANCELLED' | 'UNAVAILABLE') => Object.assign(new Error('Apple sign-in could not be completed.'), { code });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Apple's popup promise is the callback. Credentials never enter URLs, storage or user-profile objects. */
export function createAppleWebCredential({ document: dom, apple, hasUserActivation }: Dependencies) {
    let loading: Promise<AppleWebIdentity> | undefined;
    let providerPopupPending = false;

    function load(signal: AbortSignal): Promise<AppleWebIdentity> {
        const existing = apple();
        if (existing) return Promise.resolve(existing);
        if (loading) return loading;
        loading = new Promise<AppleWebIdentity>((resolve, reject) => {
            const script = dom.createElement('script');
            script.src = SCRIPT;
            script.async = true;
            let finished = false;
            const finish = (error?: Error) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                signal.removeEventListener('abort', abort);
                script.onload = null;
                script.onerror = null;
                const sdk = apple();
                if (error || !sdk) { script.remove(); reject(error ?? failure('UNAVAILABLE')); }
                else resolve(sdk);
            };
            const abort = () => finish(failure('CANCELLED'));
            const timer = setTimeout(() => finish(failure('UNAVAILABLE')), 10_000);
            script.onload = () => finish();
            script.onerror = () => finish(failure('UNAVAILABLE'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
            else dom.head.appendChild(script);
        }).catch(error => { loading = undefined; throw error; });
        return loading;
    }

    function acquire(client: { clientId: string; redirectUri: string }, challenge: ProviderAuthenticationChallenge,
        signal: AbortSignal): Promise<AppleProviderCredential> {
        if (signal.aborted) return Promise.reject(failure('CANCELLED'));
        if (providerPopupPending) return Promise.reject(failure('UNAVAILABLE'));
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (credential?: AppleProviderCredential, error?: Error) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', abort);
                if (error) reject(error); else resolve(credential!);
            };
            const abort = () => finish(undefined, failure('CANCELLED'));
            signal.addEventListener('abort', abort, { once: true });
            const launch = (sdk: AppleWebIdentity) => {
                if (settled || signal.aborted) return;
                let pending: Promise<unknown>;
                try {
                    // Discovery preloads only the SDK. The original button click
                    // supplies a fresh server challenge; slow setup can be retried
                    // from that same control without adding another confirmation.
                    if (hasUserActivation?.() === false || providerPopupPending) {
                        finish(undefined, failure('UNAVAILABLE')); return;
                    }
                    providerPopupPending = true;
                    sdk.auth.init({ clientId: client.clientId, redirectURI: client.redirectUri,
                        scope: 'email', state: challenge.state, nonce: challenge.nonce, usePopup: true });
                    pending = sdk.auth.signIn();
                } catch { providerPopupPending = false; finish(undefined, failure('UNAVAILABLE')); return; }
                void Promise.resolve(pending).then(result => {
                    if (settled || signal.aborted) return;
                    const authorization = record(result) ? result.authorization : undefined;
                    if (!record(authorization) || authorization.state !== challenge.state
                        || typeof authorization.id_token !== 'string' || authorization.id_token.length > 16_384
                        || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization.id_token)
                        || typeof authorization.code !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(authorization.code)) {
                        finish(undefined, failure('UNAVAILABLE')); return;
                    }
                    finish(Object.freeze({ idToken: authorization.id_token, authorizationCode: authorization.code }));
                }).catch(error => {
                    if (!settled) finish(undefined, failure(record(error)
                        && (error.error === 'popup_closed_by_user' || error.error === 'user_cancelled_authorize')
                        ? 'CANCELLED' : 'UNAVAILABLE'));
                }).finally(() => { providerPopupPending = false; });
            };
            try {
                if (signal.aborted) { abort(); return; }
                const sdk = apple();
                if (sdk) launch(sdk);
                else void load(signal).then(launch).catch(() =>
                    finish(undefined, failure(signal.aborted ? 'CANCELLED' : 'UNAVAILABLE')));
            } catch { finish(undefined, failure('UNAVAILABLE')); }
        });
    }

    return Object.assign(acquire, { async preload(signal: AbortSignal): Promise<void> {
        if (signal.aborted) throw failure('CANCELLED');
        await load(signal);
        if (signal.aborted) throw failure('CANCELLED');
    } });
}
