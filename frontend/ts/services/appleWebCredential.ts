import type { SweetAlertOptions } from 'sweetalert2';
import type { AppleProviderCredential, ProviderAuthenticationChallenge } from './authApi.ts';

export type AppleWebIdentity = { auth: {
    init(options: { clientId: string; redirectURI: string; scope: 'email'; state: string; nonce: string; usePopup: true }): void;
    signIn(): Promise<unknown>;
} };
type Dependencies = {
    document: Pick<Document, 'createElement' | 'head'>;
    apple(): AppleWebIdentity | undefined;
    alert: { fire(options: SweetAlertOptions): Promise<unknown>; getPopup(): HTMLElement | null;
        isVisible(): boolean; close(): void };
};
const SCRIPT = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
const failure = (code: 'CANCELLED' | 'UNAVAILABLE') => Object.assign(new Error('Apple sign-in could not be completed.'), { code });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Apple's popup promise is the callback. Credentials never enter URLs, storage or user-profile objects. */
export function createAppleWebCredential({ document: dom, apple, alert }: Dependencies) {
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

    return function acquire(client: { clientId: string; redirectUri: string }, challenge: ProviderAuthenticationChallenge,
        signal: AbortSignal): Promise<AppleProviderCredential> {
        if (signal.aborted) return Promise.reject(failure('CANCELLED'));
        if (alert.isVisible() || providerPopupPending) return Promise.reject(failure('UNAVAILABLE'));
        return new Promise((resolve, reject) => {
            const host = dom.createElement('div');
            host.textContent = 'Loading Apple sign-in.';
            let popup: HTMLElement | null = null;
            let button: HTMLButtonElement | undefined;
            let settled = false;
            const finish = (credential?: AppleProviderCredential, error?: Error, close = true) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', abort);
                if (button) button.onclick = null;
                host.replaceChildren();
                if (close && popup && alert.getPopup() === popup) alert.close();
                if (error) reject(error); else resolve(credential!);
            };
            const abort = () => finish(undefined, failure('CANCELLED'));
            const dismiss = () => finish(undefined, failure('CANCELLED'), false);
            signal.addEventListener('abort', abort, { once: true });
            try {
                const showing = alert.fire({ title: 'Continue with Apple', html: host,
                    showConfirmButton: false, showCancelButton: true, cancelButtonText: 'Cancel', allowOutsideClick: false,
                    didOpen(element) {
                        popup = element;
                        void load(signal).then(sdk => {
                            if (settled || signal.aborted) return;
                            button = dom.createElement('button');
                            button.type = 'button';
                            button.className = 'provider-sign-in__button';
                            button.textContent = 'Continue with Apple';
                            button.onclick = () => {
                                if (settled || signal.aborted || providerPopupPending) return;
                                button!.disabled = true;
                                providerPopupPending = true;
                                let pending: Promise<unknown>;
                                try {
                                    sdk.auth.init({ clientId: client.clientId, redirectURI: client.redirectUri,
                                        scope: 'email', state: challenge.state, nonce: challenge.nonce, usePopup: true });
                                    // A real click is needed here: opening after SDK/network awaits loses user activation.
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
                                    if (!settled) finish(undefined, failure(record(error) && error.error === 'popup_closed_by_user'
                                        ? 'CANCELLED' : 'UNAVAILABLE'));
                                }).finally(() => { providerPopupPending = false; });
                            };
                            host.replaceChildren(button);
                        }).catch(() => finish(undefined, failure(signal.aborted ? 'CANCELLED' : 'UNAVAILABLE')));
                    }, willClose: dismiss, didDestroy: dismiss,
                });
                popup = alert.getPopup();
                void showing.then(dismiss).catch(() => finish(undefined, failure('UNAVAILABLE')));
            } catch { finish(undefined, failure('UNAVAILABLE')); }
        });
    };
}
