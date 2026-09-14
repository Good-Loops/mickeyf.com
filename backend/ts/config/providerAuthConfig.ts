import type { ProviderAuthClient } from '../auth/providerAuthFlow';
import { createProviderTokenVerifier } from '../auth/providerTokenVerifier';

type Environment = Readonly<Record<string, string | undefined>>;
type VerifierDependencies = Parameters<typeof createProviderTokenVerifier>[1];

export type PublicProviderAuthClient = Readonly<
    | { clientKey: 'google-web'; provider: 'google'; platform: 'web'; clientId: string }
    | { clientKey: 'apple-ios'; provider: 'apple'; platform: 'ios'; clientId: string }
>;

export type ProviderAuthConfig = Readonly<{
    enabled: boolean;
    clients: Readonly<Record<string, ProviderAuthClient>>;
    publicClients: readonly PublicProviderAuthClient[];
}>;

const disabledConfig: ProviderAuthConfig = Object.freeze({
    enabled: false, clients: Object.freeze({}), publicClients: Object.freeze([]),
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
): ProviderAuthConfig {
    if (env.PROVIDER_AUTH_ENABLED !== 'true') return disabledConfig;
    if (env.GOOGLE_IOS_CLIENT_ID !== undefined) {
        throw new Error('GOOGLE_IOS_CLIENT_ID is unsupported until the native audience and presenter contract is configured');
    }
    if (env.APPLE_WEB_CLIENT_ID !== undefined || env.APPLE_WEB_SERVICES_ID !== undefined) {
        throw new Error('Apple web sign-in is unsupported until its prerequisites and callback flow are configured');
    }
    const googleWebId = optionalClientId(env, 'GOOGLE_WEB_CLIENT_ID', /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/);
    const appleIosId = optionalClientId(env, 'APPLE_IOS_BUNDLE_ID', /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/);
    if (googleWebId === undefined && appleIosId === undefined) {
        throw new Error('PROVIDER_AUTH_ENABLED requires GOOGLE_WEB_CLIENT_ID or APPLE_IOS_BUNDLE_ID');
    }

    const clients: Record<string, ProviderAuthClient> = {};
    const publicClients: PublicProviderAuthClient[] = [];
    if (googleWebId !== undefined) {
        clients['google-web'] = Object.freeze({ provider: 'google',
            verifier: createProviderTokenVerifier({ googleAudience: googleWebId }, verifierDependencies) });
        publicClients.push(Object.freeze({ clientKey: 'google-web', provider: 'google', platform: 'web', clientId: googleWebId }));
    }
    if (appleIosId !== undefined) {
        clients['apple-ios'] = Object.freeze({ provider: 'apple',
            verifier: createProviderTokenVerifier({ appleAudience: appleIosId }, verifierDependencies) });
        publicClients.push(Object.freeze({ clientKey: 'apple-ios', provider: 'apple', platform: 'ios', clientId: appleIosId }));
    }
    return Object.freeze({ enabled: true, clients: Object.freeze(clients), publicClients: Object.freeze(publicClients) });
}
