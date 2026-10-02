/** Native Apple authorization is checked before trusting or extending an app session. */
export type AppleSessionState = 'unchanged' | 'signedOut' | 'revoked';
type Listener = { remove: () => Promise<void> };
export type AppleSessionIdentity = {
    getCapabilities: () => Promise<{ apple: boolean }>;
    getCredentialState: (input: { userId: string }) => Promise<{ state: string }>;
    addListener: (event: 'appleCredentialChanged', callback: () => void) => Promise<Listener>;
};
type IdentityLoader = () => Promise<AppleSessionIdentity | null>;

async function loadNativeIdentity(): Promise<AppleSessionIdentity | null> {
    const { Capacitor, registerPlugin } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios') return null;
    return registerPlugin<AppleSessionIdentity>('LudolumeIdentity');
}

function unavailable(): Error { return new Error('Could not check Apple authorization.'); }

async function boundedCheck(check: () => Promise<AppleSessionState>): Promise<AppleSessionState> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([check(), new Promise<never>((_, reject) => {
            // These reads cannot change cookies. A late native result is safe to
            // discard, and cannot keep password login stuck behind the auth queue.
            timer = setTimeout(() => reject(unavailable()), 10_000);
        })]);
    } finally { clearTimeout(timer); }
}

export function createNativeAppleSession(apiBase: string, fetchRequest: typeof fetch,
    loadIdentity: IdentityLoader = loadNativeIdentity) {
    async function enabledIdentity(): Promise<AppleSessionIdentity | null> {
        const identity = await loadIdentity();
        if (!identity) return null;
        const capabilities = await identity.getCapabilities();
        if (capabilities.apple === false) return null;
        if (capabilities.apple !== true) throw unavailable();
        return identity;
    }

    return {
        check(): Promise<AppleSessionState> { return boundedCheck(async () => {
            try {
                const identity = await enabledIdentity();
                if (!identity) return 'unchanged';
                // The signed current session, never caller input or a cached
                // last-used Apple account, determines which credential to check.
                const response = await fetchRequest(`${apiBase}/auth/providers/apple-credential`, {
                    method: 'GET', credentials: 'include',
                });
                if (response.status === 401) return 'signedOut';
                if (!response.ok) throw unavailable();
                const result: unknown = await response.json();
                if (!result || typeof result !== 'object' || Object.keys(result).join(',') !== 'userId'
                    || !('userId' in result)) throw unavailable();
                if (result.userId === null) return 'unchanged';
                if (typeof result.userId !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(result.userId)) throw unavailable();
                const credential = await identity.getCredentialState({ userId: result.userId });
                if (credential.state === 'authorized') return 'unchanged';
                if (credential.state === 'revoked' || credential.state === 'notFound') return 'revoked';
                // A transfer or system error is not proof that consent was revoked.
                throw unavailable();
            } catch { throw unavailable(); }
        }); },
        async subscribe(callback: () => void): Promise<() => void> {
            try {
                const identity = await enabledIdentity();
                if (!identity) return () => {};
                const listener = await identity.addListener('appleCredentialChanged', callback);
                return () => { void listener.remove().catch(() => {}); };
            } catch {
                // Startup/activity checks remain available if observing fails.
                return () => {};
            }
        },
    };
}
