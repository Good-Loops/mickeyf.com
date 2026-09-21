import type { SweetAlertOptions } from 'sweetalert2';
import type { AppleProviderCredential, ProviderAuthenticationChallenge, ProviderCredential } from './authApi.ts';

export type PublicProviderClient = Readonly<
    | { clientKey: 'google-web'; provider: 'google'; platform: 'web'; clientId: string; signup?: true }
    | { clientKey: 'apple-ios'; provider: 'apple'; platform: 'ios'; clientId: string; signup?: true }
>;

type NativeIdentity = {
    getCapabilities(): Promise<unknown>;
    signIn(input: { provider: 'apple'; clientId: string; nonce: string; state: string }): Promise<unknown>;
    cancel(): Promise<unknown>;
};
type GoogleIdentity = {
    initialize(options: { client_id: string; nonce: string; callback(response: unknown): void;
        ux_mode: 'popup'; auto_select: false; button_auto_select: false }): void;
    renderButton(element: HTMLElement, options: { type: 'standard'; theme: 'outline'; size: 'large';
        text: 'continue_with'; state: string }): void;
};
type ProviderClientDependencies = {
    apiBase: string;
    fetchRequest: typeof fetch;
    platform: string;
    isNative: boolean;
    identity: NativeIdentity;
    document: Pick<Document, 'createElement' | 'head'>;
    google(): GoogleIdentity | undefined;
    alert: { fire(options: SweetAlertOptions): Promise<unknown>; getPopup(): HTMLElement | null;
        isVisible(): boolean; close(): void };
};

const GOOGLE_SCRIPT = 'https://accounts.google.com/gsi/client';
const IO_TIMEOUT_MS = 10_000;
const RANDOM_VALUE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export class ProviderCredentialError extends Error {
    readonly code: 'CANCELLED' | 'UNAVAILABLE';
    constructor(code: 'CANCELLED' | 'UNAVAILABLE') {
        super(code === 'CANCELLED' ? 'Provider sign-in was cancelled.' : 'Provider sign-in is unavailable.');
        this.name = 'ProviderCredentialError';
        this.code = code;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readClient(value: unknown): PublicProviderClient | null {
    if (!isRecord(value) || !['clientId,clientKey,platform,provider', 'clientId,clientKey,platform,provider,signup'].includes(Object.keys(value).sort().join(','))
        || ('signup' in value && value.signup !== true)
        || typeof value.clientId !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(value.clientId)) return null;
    if (value.clientKey === 'google-web' && value.provider === 'google' && value.platform === 'web') {
        return Object.freeze({ clientKey: value.clientKey, provider: value.provider, platform: value.platform, clientId: value.clientId,
            ...(value.signup === true ? { signup: true as const } : {}) });
    }
    if (value.clientKey === 'apple-ios' && value.provider === 'apple' && value.platform === 'ios') {
        return Object.freeze({ clientKey: value.clientKey, provider: value.provider, platform: value.platform, clientId: value.clientId,
            ...(value.signup === true ? { signup: true as const } : {}) });
    }
    return null;
}

function readToken(value: unknown): string {
    if (typeof value !== 'string' || value.length > 16_384
        || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
        throw new ProviderCredentialError('UNAVAILABLE');
    }
    return value;
}

function sanitizedError(error: unknown): ProviderCredentialError {
    return new ProviderCredentialError(isRecord(error) && (error.code === 'CANCELLED' || error.name === 'AbortError')
        ? 'CANCELLED' : 'UNAVAILABLE');
}

async function cancellable<Result>(operation: (signal: AbortSignal) => Promise<Result>, timeoutMs: number,
    external?: AbortSignal): Promise<Result> {
    if (external?.aborted) throw new ProviderCredentialError('CANCELLED');
    const controller = new AbortController();
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => { reject(new ProviderCredentialError('CANCELLED')); controller.abort(); };
    });
    external?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, timeoutMs);
    try {
        if (external?.aborted) abort();
        return await Promise.race([Promise.resolve().then(() => {
            if (controller.signal.aborted) throw new ProviderCredentialError('CANCELLED');
            return operation(controller.signal);
        }), cancelled]);
    } finally {
        clearTimeout(timeout);
        external?.removeEventListener('abort', abort);
        controller.abort();
    }
}

/** Browser/bridge seams keep credential lifecycle tests independent of real providers. */
export function createProviderClient(dependencies: ProviderClientDependencies) {
    const { apiBase, fetchRequest, identity, alert, document: dom } = dependencies;
    const web = !dependencies.isNative && dependencies.platform === 'web';
    const ios = dependencies.isNative && dependencies.platform === 'ios';
    let googleLoad: Promise<GoogleIdentity> | undefined;
    let acquiring = false;
    let nativeCancellationUnconfirmed = false;

    async function getAvailableProviderClients(): Promise<PublicProviderClient[]> {
        if (!web && !ios) return [];
        try {
            return await cancellable(async signal => {
                const response = await fetchRequest(`${apiBase}/auth/providers/config`, {
                    method: 'GET', credentials: 'include', signal,
                });
                if (!response.ok) return [];
                const result: unknown = await response.json();
                if (!isRecord(result) || Object.keys(result).join(',') !== 'clients'
                    || !Array.isArray(result.clients) || result.clients.length > 2) return [];
                const clients = result.clients.map(readClient);
                if (clients.some(client => client === null)
                    || new Set(clients.map(client => client?.clientKey)).size !== clients.length) return [];
                if (web) return clients.filter((client): client is PublicProviderClient => client?.platform === 'web');
                const capabilities = await identity.getCapabilities();
                return isRecord(capabilities) && capabilities.apple === true
                    ? clients.filter((client): client is PublicProviderClient => client?.platform === 'ios') : [];
            }, IO_TIMEOUT_MS);
        } catch { return []; }
    }

    function loadGoogle(signal: AbortSignal): Promise<GoogleIdentity> {
        const existing = dependencies.google();
        if (existing) return Promise.resolve(existing);
        if (googleLoad) return googleLoad;
        googleLoad = new Promise<GoogleIdentity>((resolve, reject) => {
            const script = dom.createElement('script');
            script.src = GOOGLE_SCRIPT;
            script.async = true;
            script.defer = true;
            let finished = false;
            const finish = (error?: ProviderCredentialError) => {
                if (finished) return;
                finished = true;
                clearTimeout(timeout);
                signal.removeEventListener('abort', abort);
                script.onload = null;
                script.onerror = null;
                const sdk = dependencies.google();
                if (error || !sdk) { script.remove(); reject(error ?? new ProviderCredentialError('UNAVAILABLE')); }
                else resolve(sdk);
            };
            const abort = () => finish(new ProviderCredentialError('CANCELLED'));
            const timeout = setTimeout(() => finish(new ProviderCredentialError('UNAVAILABLE')), IO_TIMEOUT_MS);
            script.onload = () => finish();
            script.onerror = () => finish(new ProviderCredentialError('UNAVAILABLE'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
            else dom.head.appendChild(script);
        }).catch(error => { googleLoad = undefined; throw sanitizedError(error); });
        return googleLoad;
    }

    function renderGoogleCredential(client: PublicProviderClient, challenge: ProviderAuthenticationChallenge,
        host: HTMLElement, signal: AbortSignal, onReady?: () => void): Promise<string> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (token?: string, error?: ProviderCredentialError) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', abort);
                host.replaceChildren();
                if (error) reject(error);
                else resolve(token!);
            };
            const abort = () => finish(undefined, new ProviderCredentialError('CANCELLED'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) { abort(); return; }
            void loadGoogle(signal).then(sdk => {
                if (settled || signal.aborted) return;
                sdk.initialize({ client_id: client.clientId, nonce: challenge.nonce,
                    ux_mode: 'popup', auto_select: false, button_auto_select: false,
                    callback(response) {
                        if (settled) return;
                        try {
                            if (!isRecord(response) || response.state !== challenge.state) {
                                throw new ProviderCredentialError('UNAVAILABLE');
                            }
                            finish(readToken(response.credential));
                        } catch { finish(undefined, new ProviderCredentialError('UNAVAILABLE')); }
                    },
                });
                host.replaceChildren();
                // Only a real click on Google's official control opens sign-in; never One Tap or a synthetic click.
                sdk.renderButton(host, { type: 'standard', theme: 'outline', size: 'large',
                    text: 'continue_with', state: challenge.state });
                onReady?.();
            }).catch(error => finish(undefined, sanitizedError(error)));
        });
    }

    function googleCredential(client: PublicProviderClient, challenge: ProviderAuthenticationChallenge, signal: AbortSignal): Promise<string> {
        if (alert.isVisible()) return Promise.reject(new ProviderCredentialError('UNAVAILABLE'));
        return new Promise<string>((resolve, reject) => {
            let popup: HTMLElement | null = null;
            let settled = false;
            const host = dom.createElement('div');
            host.style.display = 'flex';
            host.style.justifyContent = 'center';
            host.textContent = 'Loading Google sign-in…';
            const finish = (token?: string, error?: ProviderCredentialError, closePopup = true) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', abort);
                host.replaceChildren();
                if (closePopup && popup && alert.getPopup() === popup) alert.close();
                if (error) reject(error);
                else resolve(token!);
            };
            const abort = () => finish(undefined, new ProviderCredentialError('CANCELLED'));
            const dismissed = () => finish(undefined, new ProviderCredentialError('CANCELLED'), false);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) { abort(); return; }
            try {
                const showing = alert.fire({
                    title: 'Continue with Google', html: host, showConfirmButton: false,
                    showCancelButton: true, cancelButtonText: 'Cancel', allowOutsideClick: false,
                    didOpen(element) {
                        popup = element;
                        if (settled || signal.aborted) return;
                        void renderGoogleCredential(client, challenge, host, signal)
                            .then(token => finish(token)).catch(error => finish(undefined, sanitizedError(error)));
                    },
                    willClose: dismissed,
                    didDestroy: dismissed,
                });
                popup = alert.getPopup();
                void showing.then(dismissed).catch(() => finish(undefined, new ProviderCredentialError('UNAVAILABLE')));
            } catch { finish(undefined, new ProviderCredentialError('UNAVAILABLE')); }
        });
    }

    async function nativeCredential(client: PublicProviderClient, challenge: ProviderAuthenticationChallenge, signal: AbortSignal): Promise<AppleProviderCredential> {
        const capabilities = await identity.getCapabilities();
        if (signal.aborted) throw new ProviderCredentialError('CANCELLED');
        if (!isRecord(capabilities) || capabilities.apple !== true) throw new ProviderCredentialError('UNAVAILABLE');
        const abort = () => {
            // cancel() has no request ID: its delayed effect must not reach a newer sign-in.
            nativeCancellationUnconfirmed = true;
            void Promise.resolve().then(() => identity.cancel()).then(() => {
                nativeCancellationUnconfirmed = false;
            }).catch(() => {
                // Without acknowledgement, keep native retries blocked until the client reloads.
            });
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
            const result = await identity.signIn({ provider: 'apple', clientId: client.clientId,
                nonce: challenge.nonce, state: challenge.state });
            if (signal.aborted) throw new ProviderCredentialError('CANCELLED');
            if (!isRecord(result) || Object.keys(result).sort().join(',') !== 'authorizationCode,identityToken'
                || typeof result.authorizationCode !== 'string' || result.authorizationCode.length < 1
                || result.authorizationCode.length > 4096 || /[^\x21-\x7e]/.test(result.authorizationCode)) {
                throw new ProviderCredentialError('UNAVAILABLE');
            }
            return Object.freeze({ idToken: readToken(result.identityToken), authorizationCode: result.authorizationCode });
        } finally { signal.removeEventListener('abort', abort); }
    }

    function acquireProviderCredential(client: PublicProviderClient, challenge: ProviderAuthenticationChallenge,
        signal: AbortSignal, inline: { host: HTMLElement; onReady?: () => void }): Promise<string>;
    function acquireProviderCredential(client: PublicProviderClient, challenge: ProviderAuthenticationChallenge,
        signal: AbortSignal): Promise<ProviderCredential>;
    async function acquireProviderCredential(client: PublicProviderClient, challenge: ProviderAuthenticationChallenge,
        signal: AbortSignal, inline?: { host: HTMLElement; onReady?: () => void }): Promise<ProviderCredential> {
        const selected = readClient(client);
        if (!selected || acquiring || (selected.platform === 'web' ? !web : !ios)
            || (selected.platform === 'ios' && nativeCancellationUnconfirmed)
            || (inline && selected.clientKey !== 'google-web')
            || !isRecord(challenge) || Object.keys(challenge).sort().join(',') !== 'expiresInSeconds,nonce,state'
            || typeof challenge.state !== 'string' || !RANDOM_VALUE.test(challenge.state)
            || typeof challenge.nonce !== 'string' || !RANDOM_VALUE.test(challenge.nonce)
            || !Number.isInteger(challenge.expiresInSeconds) || challenge.expiresInSeconds < 1 || challenge.expiresInSeconds > 300) {
            throw new ProviderCredentialError('UNAVAILABLE');
        }
        acquiring = true;
        try {
            return await cancellable<ProviderCredential>(activeSignal => inline
                ? renderGoogleCredential(selected, challenge, inline.host, activeSignal, inline.onReady)
                : selected.platform === 'web'
                ? googleCredential(selected, challenge, activeSignal) : nativeCredential(selected, challenge, activeSignal),
            challenge.expiresInSeconds * 1000, signal);
        } catch (error) { throw sanitizedError(error); }
        finally { acquiring = false; }
    }

    return {
        getAvailableProviderClients,
        acquireProviderCredential,
        acquireGoogleCredentialInline: (client: PublicProviderClient, challenge: ProviderAuthenticationChallenge,
            host: HTMLElement, signal: AbortSignal, onReady?: () => void) =>
            acquireProviderCredential(client, challenge, signal, { host, onReady }),
    };
}

let configured: Promise<ReturnType<typeof createProviderClient>> | undefined;
function configuredClient() {
    configured ??= Promise.all([import('../config/apiConfig.ts'), import('./apiFetch.ts'),
        import('@capacitor/core'), import('../components/siteAlert.ts')]).then(([config, transport, capacitor, alerts]) => {
        const identity = capacitor.registerPlugin<NativeIdentity>('LudolumeIdentity');
        return createProviderClient({ apiBase: config.API_BASE, fetchRequest: transport.apiFetch,
            platform: capacitor.Capacitor.getPlatform(), isNative: capacitor.Capacitor.isNativePlatform(),
            identity, alert: alerts.default, document,
            google: () => {
                const sdk = (window as Window & { google?: { accounts?: { id?: GoogleIdentity } } }).google?.accounts?.id;
                return sdk && typeof sdk.initialize === 'function' && typeof sdk.renderButton === 'function' ? sdk : undefined;
            },
        });
    }).catch(error => { configured = undefined; throw error; });
    return configured;
}

export async function getAvailableProviderClients(): Promise<PublicProviderClient[]> {
    try { return await (await configuredClient()).getAvailableProviderClients(); }
    catch { return []; }
}

export async function acquireProviderCredential(client: PublicProviderClient, challenge: ProviderAuthenticationChallenge,
    signal: AbortSignal): Promise<ProviderCredential> {
    try { return await (await configuredClient()).acquireProviderCredential(client, challenge, signal); }
    catch (error) { throw sanitizedError(error); }
}

/** Render the official button in the login form, without adding an intermediate dialog. */
export async function acquireGoogleCredentialInline(client: PublicProviderClient, challenge: ProviderAuthenticationChallenge,
    host: HTMLElement, signal: AbortSignal, onReady?: () => void): Promise<string> {
    try { return await (await configuredClient()).acquireGoogleCredentialInline(client, challenge, host, signal, onReady); }
    catch (error) { throw sanitizedError(error); }
}
