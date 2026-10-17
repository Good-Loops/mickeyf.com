import type { SweetAlertOptions } from 'sweetalert2';
import type { ProviderAuthenticationChallenge, ProviderCredential } from './authApi.ts';
import { createAppleWebCredential, type AppleWebIdentity } from './appleWebCredential.ts';

export type PublicProviderClient = Readonly<(
    | { clientKey: 'google-web'; provider: 'google'; platform: 'web'; clientId: string; signup?: true }
    | { clientKey: 'google-ios'; provider: 'google'; platform: 'ios'; clientId: string; signup?: true }
    | { clientKey: 'google-android'; provider: 'google'; platform: 'android'; clientId: string; signup?: true }
    | { clientKey: 'apple-ios'; provider: 'apple'; platform: 'ios'; clientId: string; signup?: true }
    | { clientKey: 'apple-web'; provider: 'apple'; platform: 'web'; clientId: string; redirectUri: string; signup?: true }
) & { issuance?: false }>;

type NativeIdentity = {
    getCapabilities(): Promise<unknown>;
    signIn(input: { provider: 'apple' | 'google'; clientId: string; nonce: string; state: string }): Promise<unknown>;
    cancel(): Promise<unknown>;
};
type GoogleIdentity = {
    initialize(options: { client_id: string; nonce: string; callback(response: unknown): void;
        ux_mode: 'popup'; auto_select: false; button_auto_select: false }): void;
    renderButton(element: HTMLElement, options: { type: 'standard'; theme: 'outline'; size: 'large';
        shape: 'pill'; width: string; logo_alignment: 'left'; text: 'continue_with'; locale: 'en'; state: string }): void;
};
type ProviderClientDependencies = {
    apiBase: string;
    fetchRequest: typeof fetch;
    platform: string;
    isNative: boolean;
    identity: NativeIdentity;
    document: Pick<Document, 'createElement' | 'head'>;
    google(): GoogleIdentity | undefined;
    apple?(): AppleWebIdentity | undefined;
    hasUserActivation?(): boolean;
    alert: { fire(options: SweetAlertOptions): Promise<unknown>; getPopup(): HTMLElement | null;
        isVisible(): boolean; close(): void };
};

const GOOGLE_SCRIPT = 'https://accounts.google.com/gsi/client?hl=en';
const GOOGLE_STYLE = 'https://accounts.google.com/gsi/style';
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
    if (!isRecord(value)) return null;
    const keys = ['clientId', 'clientKey', 'platform', 'provider',
        ...(value.clientKey === 'apple-web' ? ['redirectUri'] : []),
        ...('signup' in value ? ['signup'] : []), ...('issuance' in value ? ['issuance'] : [])];
    if (Object.keys(value).sort().join(',') !== keys.sort().join(',')
        || ('signup' in value && value.signup !== true)
        || ('issuance' in value && (value.issuance !== false || value.signup === true))
        || typeof value.clientId !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(value.clientId)) return null;
    const availability = value.issuance === false ? { issuance: false as const } : {};
    if (value.provider === 'google' && ((value.clientKey === 'google-web' && value.platform === 'web')
        || (value.clientKey === 'google-ios' && value.platform === 'ios')
        || (value.clientKey === 'google-android' && value.platform === 'android'))) {
        return Object.freeze({ clientKey: value.clientKey, provider: value.provider, platform: value.platform, clientId: value.clientId,
            ...(value.signup === true ? { signup: true as const } : {}), ...availability }) as PublicProviderClient;
    }
    if (value.clientKey === 'apple-ios' && value.provider === 'apple' && value.platform === 'ios') {
        return Object.freeze({ clientKey: value.clientKey, provider: value.provider, platform: value.platform, clientId: value.clientId,
            ...(value.signup === true ? { signup: true as const } : {}), ...availability });
    }
    if (value.clientKey === 'apple-web' && value.provider === 'apple' && value.platform === 'web'
        && typeof value.redirectUri === 'string' && value.redirectUri.length <= 2048) {
        try {
            const url = new URL(value.redirectUri);
            if (url.protocol !== 'https:' || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname)
                || url.hostname.endsWith('.localhost') || url.username || url.password || url.port || url.search || url.hash
                || url.href !== value.redirectUri) return null;
            return Object.freeze({ clientKey: value.clientKey, provider: value.provider, platform: value.platform,
                clientId: value.clientId, redirectUri: value.redirectUri,
                ...(value.signup === true ? { signup: true as const } : {}), ...availability });
        } catch { return null; }
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
    const appleCredential = createAppleWebCredential({ document: dom, apple: dependencies.apple ?? (() => undefined),
        hasUserActivation: dependencies.hasUserActivation });
    const web = !dependencies.isNative && dependencies.platform === 'web';
    const native = dependencies.isNative && ['ios', 'android'].includes(dependencies.platform);
    let googleLoad: Promise<GoogleIdentity> | undefined;
    let googleStylePreloaded = false;
    let acquiring = false;
    let nativeCancellationUnconfirmed = false;

    async function getAvailableProviderClients(onAvailable?: (clients: PublicProviderClient[]) => void): Promise<PublicProviderClient[]> {
        if (!web && !native) return [];
        try {
            const available = await cancellable(async signal => {
                const response = await fetchRequest(`${apiBase}/auth/providers/config`, {
                    method: 'GET', credentials: 'include', signal,
                });
                if (!response.ok) return [];
                const result: unknown = await response.json();
                if (!isRecord(result) || Object.keys(result).join(',') !== 'clients'
                    || !Array.isArray(result.clients) || result.clients.length > 5) return [];
                const clients = result.clients.map(readClient);
                if (clients.some(client => client === null)
                    || new Set(clients.map(client => client?.clientKey)).size !== clients.length) return [];
                if (web) return clients.filter((client): client is PublicProviderClient => client?.platform === 'web');
                const capabilities = await identity.getCapabilities();
                return isRecord(capabilities)
                    ? clients.filter((client): client is PublicProviderClient => client !== null
                        && client.platform === dependencies.platform && capabilities[client.provider] === true) : [];
            }, IO_TIMEOUT_MS);
            // Loading public SDK code does not prepare a provider attempt or replace Google's binding.
            // A blocked Apple script must not remove otherwise available Google sign-in.
            if (web && available.some(client => client.clientKey === 'apple-web' && client.issuance !== false)) {
                onAvailable?.(available.filter(client => client.clientKey !== 'apple-web'));
                try { await cancellable(signal => appleCredential.preload(signal), IO_TIMEOUT_MS); }
                catch {
                    return available.map(client => client.clientKey === 'apple-web'
                        ? Object.freeze({ clientKey: client.clientKey, provider: client.provider, platform: client.platform,
                            clientId: client.clientId, redirectUri: client.redirectUri, issuance: false as const }) : client);
                }
            }
            return available;
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

    async function preloadGoogleSignInResources(signal: AbortSignal): Promise<void> {
        if (!web) return;
        if (!googleStylePreloaded && !signal.aborted
            && !dom.head.querySelector?.('link[data-google-signin-preload="style"]')) {
            // GIS otherwise requests this public resource only after the server challenge returns.
            // A preload warms its cache; readiness still waits for GIS's actual stylesheet and control.
            const stylesheet = dom.createElement('link');
            stylesheet.rel = 'preload';
            stylesheet.as = 'style';
            stylesheet.href = GOOGLE_STYLE;
            stylesheet.dataset.googleSigninPreload = 'style';
            dom.head.appendChild(stylesheet);
            googleStylePreloaded = true;
        }
        await cancellable(async activeSignal => { await loadGoogle(activeSignal); }, IO_TIMEOUT_MS, signal);
    }

    function waitForGoogleButtonStyles(signal: AbortSignal): Promise<void> {
        // GIS injects a normal stylesheet link before rendering its public control.
        // Wait for that resource rather than exposing an unstyled, briefly grey button.
        const links = Array.from(dom.head.querySelectorAll?.<HTMLLinkElement>('link[rel="stylesheet"]') ?? [])
            .filter(link => {
                try { const url = new URL(link.href); return url.origin === 'https://accounts.google.com' && url.pathname === '/gsi/style'; }
                catch { return false; }
            });
        return Promise.all(links.map(link => link.sheet ? Promise.resolve() : new Promise<void>((resolve, reject) => {
            let finished = false;
            const finish = (error?: ProviderCredentialError) => {
                if (finished) return;
                finished = true; clearTimeout(timer);
                link.removeEventListener('load', loaded); link.removeEventListener('error', failed);
                signal.removeEventListener('abort', aborted);
                if (error) reject(error); else resolve();
            };
            const loaded = () => finish();
            const failed = () => finish(new ProviderCredentialError('UNAVAILABLE'));
            const aborted = () => finish(new ProviderCredentialError('CANCELLED'));
            const timer = setTimeout(failed, IO_TIMEOUT_MS);
            link.addEventListener('load', loaded, { once: true }); link.addEventListener('error', failed, { once: true });
            signal.addEventListener('abort', aborted, { once: true });
            if (signal.aborted) aborted(); else if (link.sheet) loaded();
        }))).then(() => undefined);
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
                const width = Math.max(200, Math.min(400, Math.round(host.clientWidth || host.parentElement?.clientWidth || 320)));
                sdk.renderButton(host, { type: 'standard', theme: 'outline', size: 'large', shape: 'pill',
                    width: String(width), logo_alignment: 'left', text: 'continue_with', locale: 'en', state: challenge.state });
                void waitForGoogleButtonStyles(signal).then(() => {
                    if (!settled && !signal.aborted) onReady?.();
                }).catch(error => finish(undefined, sanitizedError(error)));
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

    async function nativeCredential(client: PublicProviderClient, challenge: ProviderAuthenticationChallenge, signal: AbortSignal): Promise<ProviderCredential> {
        const capabilities = await identity.getCapabilities();
        if (signal.aborted) throw new ProviderCredentialError('CANCELLED');
        if (!isRecord(capabilities) || capabilities[client.provider] !== true) throw new ProviderCredentialError('UNAVAILABLE');
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
            const result = await identity.signIn({ provider: client.provider, clientId: client.clientId,
                nonce: challenge.nonce, state: challenge.state });
            if (signal.aborted) throw new ProviderCredentialError('CANCELLED');
            if (client.provider === 'google') {
                if (!isRecord(result) || Object.keys(result).join(',') !== 'identityToken') throw new ProviderCredentialError('UNAVAILABLE');
                return readToken(result.identityToken);
            }
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
        if (!selected || acquiring || (selected.platform === 'web' ? !web : !native || selected.platform !== dependencies.platform)
            || (selected.platform !== 'web' && nativeCancellationUnconfirmed)
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
                ? selected.clientKey === 'apple-web' ? appleCredential(selected, challenge, activeSignal)
                    : googleCredential(selected, challenge, activeSignal) : nativeCredential(selected, challenge, activeSignal),
            challenge.expiresInSeconds * 1000, signal);
        } catch (error) { throw sanitizedError(error); }
        finally { acquiring = false; }
    }

    return {
        getAvailableProviderClients,
        preloadGoogleSignInResources,
        preloadProviderCredential: (client: PublicProviderClient, signal: AbortSignal) =>
            cancellable(async activeSignal => {
                const selected = readClient(client);
                if (!web || selected?.clientKey !== 'google-web' || selected.issuance === false) {
                    throw new ProviderCredentialError('UNAVAILABLE');
                }
                await loadGoogle(activeSignal);
            }, IO_TIMEOUT_MS, signal),
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
            hasUserActivation: () => navigator.userActivation?.isActive !== false,
            google: () => {
                const sdk = (window as Window & { google?: { accounts?: { id?: GoogleIdentity } } }).google?.accounts?.id;
                return sdk && typeof sdk.initialize === 'function' && typeof sdk.renderButton === 'function' ? sdk : undefined;
            },
            apple: () => {
                const sdk = (window as Window & { AppleID?: AppleWebIdentity }).AppleID;
                return sdk && typeof sdk.auth?.init === 'function' && typeof sdk.auth?.signIn === 'function' ? sdk : undefined;
            },
        });
    }).catch(error => { configured = undefined; throw error; });
    return configured;
}

export async function getAvailableProviderClients(onAvailable?: (clients: PublicProviderClient[]) => void): Promise<PublicProviderClient[]> {
    try { return await (await configuredClient()).getAvailableProviderClients(onAvailable); }
    catch { return []; }
}

export async function preloadProviderCredential(client: PublicProviderClient, signal: AbortSignal): Promise<void> {
    try { await (await configuredClient()).preloadProviderCredential(client, signal); }
    catch (error) { throw sanitizedError(error); }
}

/** Warm public rendering resources on auth routes while the existing session check runs. No auth requests. */
export function preloadGoogleSignInForRoute(pathname: string): () => void {
    const controller = new AbortController();
    if (/^\/(?:login|signup)\/?$/u.test(pathname)) {
        void Promise.all([configuredClient(), import('../config/apiConfig.ts')]).then(async ([client, config]) => {
            if (!config.LEGACY_PUBLIC_API_PREVIEW && !controller.signal.aborted) {
                await client.preloadGoogleSignInResources(controller.signal);
            }
        }).catch(() => { /* The visible control owns bounded failure/retry feedback. */ });
    }
    return () => controller.abort();
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
