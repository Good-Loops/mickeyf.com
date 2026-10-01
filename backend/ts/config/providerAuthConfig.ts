import type { ProviderAuthClient } from '../auth/providerAuthFlow';
import { createProviderTokenVerifier } from '../auth/providerTokenVerifier';
import { loadAppleTokenConfig, type AppleTokenLifecycle } from './appleTokenConfig';
import { loadAppleNotificationConfig } from './appleNotificationConfig';
import type { AppleNotificationVerifier } from '../auth/appleNotificationVerifier';
import { loadAppleRuntimeLifecycle } from './appleRuntimeSecrets';
import { loadAppleWebConfig } from './appleWebConfig';

type Environment = Readonly<Record<string, string | undefined>>;
type VerifierDependencies = Parameters<typeof createProviderTokenVerifier>[1];

export type PublicProviderAuthClient = Readonly<
    | { clientKey: 'google-web'; provider: 'google'; platform: 'web'; clientId: string; signup?: true }
    | { clientKey: 'google-ios'; provider: 'google'; platform: 'ios'; clientId: string; signup?: true }
    | { clientKey: 'google-android'; provider: 'google'; platform: 'android'; clientId: string; signup?: true }
    | { clientKey: 'apple-ios'; provider: 'apple'; platform: 'ios'; clientId: string; signup?: true }
    | { clientKey: 'apple-web'; provider: 'apple'; platform: 'web'; clientId: string; redirectUri: string; signup?: true }
>;

export type ProviderAuthConfig = Readonly<{
    enabled: boolean;
    signupEnabled: boolean;
    clients: Readonly<Record<string, ProviderAuthClient>>;
    publicClients: readonly PublicProviderAuthClient[];
    appleTokenLifecycle?: AppleTokenLifecycle;
    appleNotifications?: AppleNotificationVerifier;
}>;

const disabledConfig: ProviderAuthConfig = Object.freeze({
    enabled: false, signupEnabled: false, clients: Object.freeze({}), publicClients: Object.freeze([]),
});

function optionalClientId(env: Environment, name: string, pattern: RegExp): string | undefined {
    const value = env[name];
    if (value === undefined) return undefined;
    // Client IDs are exact audiences: trimming or case folding can silently select another value.
    if (value.length === 0 || value.length > 255 || value !== value.trim() || !pattern.test(value)) {
        throw new Error(`${name} must be one exact, nonempty provider client identifier without whitespace`);
    }
    return value;
}

/** Server-owned client selection; constructing verifiers never fetches provider keys. */
export function loadProviderAuthConfig(
    env: Environment = process.env, verifierDependencies: VerifierDependencies = {},
    runtimeLifecycle?: AppleTokenLifecycle,
): ProviderAuthConfig {
    const appleNotifications = loadAppleNotificationConfig(env, verifierDependencies);
    if (env.PROVIDER_AUTH_ENABLED !== 'true') return appleNotifications
        ? Object.freeze({ ...disabledConfig, appleNotifications }) : disabledConfig;
    const appleWeb = loadAppleWebConfig(env);
    const appleWebEnabled = env.APPLE_WEB_AUTH_ENABLED === 'true';
    const googleWebId = optionalClientId(env, 'GOOGLE_WEB_CLIENT_ID', /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/);
    const googleIosId = optionalClientId(env, 'GOOGLE_IOS_CLIENT_ID', /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/);
    const googleAndroidId = optionalClientId(env, 'GOOGLE_ANDROID_CLIENT_ID', /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/);
    const nativeGoogleIds = [googleIosId, googleAndroidId].filter(id => id !== undefined);
    if (nativeGoogleIds.length && !googleWebId) throw new Error('Native Google requires GOOGLE_WEB_CLIENT_ID as its server audience');
    if (new Set([googleWebId, ...nativeGoogleIds]).size !== 1 + nativeGoogleIds.length) {
        throw new Error('Google web, iOS and Android require distinct client identifiers');
    }
    const appleIosId = optionalClientId(env, 'APPLE_IOS_BUNDLE_ID', /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/);
    const googleSignupEnabled = env.PROVIDER_GOOGLE_SIGNUP_ENABLED === 'true';
    const appleSignupRequested = env.PROVIDER_APPLE_SIGNUP_ENABLED === 'true';
    const appleDeletionRequested = env.PROVIDER_APPLE_DELETION_ENABLED === 'true';
    const runtimeSecrets = env.APPLE_TOKEN_RUNTIME_SECRETS_ENABLED === 'true';
    if (appleSignupRequested || appleDeletionRequested || appleWebEnabled) {
        if (!appleIosId || !runtimeSecrets || env.APPLE_TOKEN_LIFECYCLE_ENABLED !== 'true'
            || env.APPLE_NOTIFICATIONS_ENABLED !== 'true' || env.APPLE_MAINTENANCE_HTTP_ENABLED !== 'true'
            || env.ACCOUNT_DELETION_ENABLED !== 'true') {
            throw new Error('Apple account actions require the native client, runtime credentials, lifecycle, notifications, maintenance and account deletion.');
        }
        if (appleSignupRequested && !appleDeletionRequested) {
            throw new Error('Apple signup requires explicit Apple account deletion.');
        }
    }
    // Runtime secret access happens after configuration and cannot prevent DB-only cleanup.
    const appleTokenLifecycle = runtimeSecrets ? runtimeLifecycle : loadAppleTokenConfig(env);
    if (appleTokenLifecycle && appleTokenLifecycle.clientId !== appleIosId) {
        throw new Error('Apple lifecycle audience does not match the configured client.');
    }
    if (appleTokenLifecycle && (appleTokenLifecycle.web?.clientId !== appleWeb?.clientId
        || appleTokenLifecycle.web?.redirectUri !== appleWeb?.redirectUri)) {
        throw new Error('Apple web lifecycle does not match the configured Services ID and return URL.');
    }
    if (appleTokenLifecycle && !appleNotifications) throw new Error('Apple sign-in requires enabled server notifications.');
    if (googleSignupEnabled && !googleWebId) throw new Error('Google signup requires GOOGLE_WEB_CLIENT_ID');
    if (googleWebId === undefined && appleIosId === undefined) {
        throw new Error('PROVIDER_AUTH_ENABLED requires GOOGLE_WEB_CLIENT_ID or APPLE_IOS_BUNDLE_ID');
    }

    const clients: Record<string, ProviderAuthClient> = {};
    const publicClients: PublicProviderAuthClient[] = [];
    if (googleWebId !== undefined) {
        clients['google-web'] = Object.freeze({ provider: 'google', signupEnabled: googleSignupEnabled,
            verifier: createProviderTokenVerifier({ googleAudience: googleWebId }, verifierDependencies) });
        publicClients.push(Object.freeze({ clientKey: 'google-web', provider: 'google', platform: 'web', clientId: googleWebId,
            ...(googleSignupEnabled ? { signup: true as const } : {}) }));
    }
    for (const [clientKey, presenter] of [
        ['google-ios', googleIosId], ['google-android', googleAndroidId],
    ] as const) {
        if (presenter === undefined || googleWebId === undefined) continue;
        // Native tokens name the server audience and the exact native authorized presenter.
        clients[clientKey] = Object.freeze({ provider: 'google', signupEnabled: googleSignupEnabled,
            verifier: createProviderTokenVerifier({ googleAudience: googleWebId, googleAuthorizedParty: presenter }, verifierDependencies) });
        publicClients.push(Object.freeze({ ...(clientKey === 'google-ios'
            ? { clientKey, platform: 'ios' as const } : { clientKey, platform: 'android' as const }), provider: 'google' as const, clientId: googleWebId,
            ...(googleSignupEnabled ? { signup: true as const } : {}) }));
    }
    if (appleIosId !== undefined) {
        clients['apple-ios'] = Object.freeze({ provider: 'apple',
            ...(appleTokenLifecycle ? { appleTokens: appleTokenLifecycle.client } : {}),
            // Requested capabilities remain unavailable until runtime credential loading succeeds.
            signupEnabled: appleSignupRequested && !!appleTokenLifecycle,
            deletionEnabled: appleDeletionRequested && !!appleTokenLifecycle,
            verifier: createProviderTokenVerifier({ appleAudience: appleIosId }, verifierDependencies) });
        if (!runtimeSecrets || appleTokenLifecycle) {
            publicClients.push(Object.freeze({ clientKey: 'apple-ios', provider: 'apple', platform: 'ios', clientId: appleIosId,
                ...(appleSignupRequested && appleTokenLifecycle ? { signup: true as const } : {}) }));
        }
    }
    if (appleWebEnabled && appleWeb) {
        clients['apple-web'] = Object.freeze({ provider: 'apple',
            ...(appleTokenLifecycle?.web ? { appleTokens: appleTokenLifecycle.web.client } : {}),
            signupEnabled: appleSignupRequested && !!appleTokenLifecycle?.web,
            deletionEnabled: appleDeletionRequested && !!appleTokenLifecycle?.web,
            verifier: createProviderTokenVerifier({ appleAudience: appleWeb.clientId }, verifierDependencies) });
        if (appleTokenLifecycle?.web) publicClients.push(Object.freeze({ clientKey: 'apple-web', provider: 'apple',
            platform: 'web', clientId: appleWeb.clientId, redirectUri: appleWeb.redirectUri,
            ...(appleSignupRequested ? { signup: true as const } : {}) }));
    }
    return Object.freeze({ enabled: true, signupEnabled: googleSignupEnabled || appleSignupRequested,
        clients: Object.freeze(clients), publicClients: Object.freeze(publicClients),
        ...(appleTokenLifecycle ? { appleTokenLifecycle } : {}), ...(appleNotifications ? { appleNotifications } : {}) });
}

/** A credential outage disables Apple issuance, not Google, notifications or maintenance. */
export async function prepareRuntimeProviderAuth(config: ProviderAuthConfig, env: Environment = process.env,
    dependencies: Readonly<{ loadLifecycle?: () => Promise<AppleTokenLifecycle>; reportUnavailable?: () => void }> = {},
): Promise<ProviderAuthConfig> {
    if (env.APPLE_TOKEN_RUNTIME_SECRETS_ENABLED !== 'true' || env.APPLE_TOKEN_LIFECYCLE_ENABLED !== 'true'
        || !config.enabled || !config.clients['apple-ios']) return config;
    try {
        const lifecycle = await (dependencies.loadLifecycle ?? (() => loadAppleRuntimeLifecycle(env)))();
        return loadProviderAuthConfig(env, {}, lifecycle);
    } catch {
        (dependencies.reportUnavailable ?? (() => console.error(JSON.stringify({
            component: 'apple-runtime-credentials', severity: 'ERROR', status: 'unavailable',
        }))))();
        return config;
    }
}
