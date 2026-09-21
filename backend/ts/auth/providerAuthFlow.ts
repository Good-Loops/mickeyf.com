import { createHash, randomBytes } from 'node:crypto';
import type { AccountLinkTarget, ProviderAccount, ProviderLinkResult, ProviderAccountCreationResult } from '../accounts/providerAccountRepository';
import { AccountDeletionPendingError, type AccountDeletionResult } from '../accounts/accountDeletionRepository';
import { isRecord, validateLoginRequest } from '../security/userRequestValidation';
import type { SessionProof } from '../security/sessionPolicy';
import type { ProviderAuthContext } from './providerAuthContext';
import type { ProviderAttempt, ConsumedProviderAttempt, ProviderAttemptAction, ProviderAttemptCreateResult } from './providerAttemptRepository';
import type { IdentityProvider, VerifiedProviderIdentity } from './providerIdentity';
import { type ProviderTokenVerifier, PROVIDER_TOKEN_MAX_LENGTH } from './providerTokenVerifier';
import { AppleTokenClientError, type AppleTokenClient } from './appleTokenClient';

export type ProviderAuthClient = Readonly<{
    provider: IdentityProvider;
    verifier: ProviderTokenVerifier;
    appleTokens?: AppleTokenClient;
    /** Native Apple account creation/deletion require separate reviewed activation. */
    signupEnabled?: boolean;
    deletionEnabled?: boolean;
}>;
type Failure = { ok: false; reason: 'UNAVAILABLE' | 'INVALID_REQUEST' | 'INVALID_CONTEXT'
    | 'BUSY' | 'INVALID_ATTEMPT' | 'INVALID_PROVIDER_TOKEN' | 'NOT_LINKED' | 'INVALID_PASSWORD'
    | 'LINK_CONFLICT' | 'ACCOUNT_GONE' | 'DUPLICATE_USER' | 'ALREADY_LINKED' | 'INVALID_USERNAME' | 'INVALID_EMAIL'
    | 'ACCOUNT_DELETION_UNAVAILABLE' | 'ACCOUNT_DELETION_PENDING' };
export type ProviderChallengeResult = Failure | { ok: true; state: string; nonce: string; expiresInSeconds: number };
export type ProviderCompletionResult = Failure
    | { ok: true; type: 'account-verified'; account: ProviderAccount; authenticationMethod?: 'apple' }
    | { ok: true; type: 'signup-required'; state: string; nonce: string; expiresInSeconds: number }
    | { ok: true; type: 'linked' }
    | { ok: true; type: 'deleted' };

export type ProviderAuthFlowDependencies = {
    attempts: {
        create(attempt: ProviderAttempt): Promise<ProviderAttemptCreateResult>;
        consume(stateHash: Buffer, bindingHash: Buffer, clientKey: string, action: ProviderAttemptAction): Promise<ConsumedProviderAttempt | null>;
    };
    accounts: {
        find(identity: VerifiedProviderIdentity): Promise<ProviderAccount | null>;
        link(target: AccountLinkTarget, password: string, identity: VerifiedProviderIdentity, session: SessionProof, appleRefreshToken?: string): Promise<ProviderLinkResult>;
        create?(identity: VerifiedProviderIdentity, userName: string, appleRefreshToken?: string): Promise<ProviderAccountCreationResult>;
        delete?(target: AccountLinkTarget, identity: VerifiedProviderIdentity, session: SessionProof, appleRefreshToken?: string): Promise<AccountDeletionResult>;
        saveAppleToken?(account: ProviderAccount, identity: VerifiedProviderIdentity, refreshToken: string): Promise<void>;
    };
    clients: Readonly<Record<string, ProviderAuthClient>>;
    enabled?: boolean;
    signupEnabled?: boolean;
    deletionEnabled?: boolean;
};

function inputClient(input: unknown, clients: ReadonlyMap<string, ProviderAuthClient>) {
    if (!isRecord(input) || typeof input.clientKey !== 'string' || typeof input.action !== 'string'
        || !['login', 'link', 'signup', 'delete'].includes(input.action)) return null;
    const client = clients.get(input.clientKey);
    if ((input.action === 'signup' || input.action === 'delete')
        && !supportsPasswordlessAccounts(input.clientKey, client)) return null;
    return client ? { client, clientKey: input.clientKey, action: input.action as ProviderAttemptAction } : null;
}

function supportsPasswordlessAccounts(clientKey: string, client: ProviderAuthClient | undefined): boolean {
    return clientKey === 'google-web' && client?.provider === 'google'
        || clientKey === 'apple-ios' && client?.provider === 'apple';
}

function matchesContext(context: ProviderAuthContext | null, action: ProviderAttemptAction): context is ProviderAuthContext {
    return context !== null && Buffer.isBuffer(context.bindingHash) && context.bindingHash.length === 32
        && (action === 'login' || action === 'signup' ? context.account === null && context.session === null
            : context.account !== null && context.session !== null);
}

/**
 * ID-token workflow; the opt-in HTTP adapter owns session issuance.
 * `account-verified` is an internal decision, NOT a login session or browser proof.
 */
export function createProviderAuthFlow({ attempts, accounts, clients, enabled = false,
    signupEnabled = false, deletionEnabled = false }: ProviderAuthFlowDependencies) {
    // A Map excludes inherited names such as __proto__, and captures server configuration once.
    const configuredClients = new Map(Object.entries(clients).map(([key, client]) => {
        if (!/^[a-z0-9_-]{1,64}$/.test(key) || !['google', 'apple'].includes(client.provider)
            || typeof client.verifier?.verify !== 'function') throw new TypeError('Invalid provider client configuration.');
        if ([client.signupEnabled, client.deletionEnabled].some(value => value !== undefined && typeof value !== 'boolean')) {
            throw new TypeError('Invalid provider client configuration.');
        }
        return [key, Object.freeze({ ...client })] as const;
    }));
    function signupAvailable(clientKey: string, client: ProviderAuthClient): boolean {
        return signupEnabled && !!accounts.create && supportsPasswordlessAccounts(clientKey, client)
            && (client.provider !== 'apple' || client.signupEnabled === true);
    }
    function unavailableAction(action: ProviderAttemptAction, clientKey: string, client: ProviderAuthClient): Failure | null {
        if (client.provider === 'apple' && (!client.appleTokens || !accounts.saveAppleToken)) {
            return { ok: false, reason: 'UNAVAILABLE' };
        }
        if (action === 'signup' && !signupAvailable(clientKey, client)) return { ok: false, reason: 'UNAVAILABLE' };
        if (action === 'delete' && (!deletionEnabled || !accounts.delete
            || (client.provider === 'apple' && client.deletionEnabled !== true))) {
            return { ok: false, reason: 'ACCOUNT_DELETION_UNAVAILABLE' };
        }
        return null;
    }
    return {
        async begin(context: ProviderAuthContext | null, input: unknown): Promise<ProviderChallengeResult> {
            if (!enabled) return { ok: false, reason: 'UNAVAILABLE' };
            const selection = inputClient(input, configuredClients);
            if (!selection || !isRecord(input) || Object.keys(input).sort().join(',') !== 'action,clientKey') {
                return { ok: false, reason: 'INVALID_REQUEST' };
            }
            const unavailable = unavailableAction(selection.action, selection.clientKey, selection.client);
            if (unavailable) return unavailable;
            if (!matchesContext(context, selection.action)) return { ok: false, reason: 'INVALID_CONTEXT' };
            const state = randomBytes(32).toString('base64url');
            const nonce = randomBytes(32).toString('base64url');
            try {
                const created = await attempts.create({
                    stateHash: createHash('sha256').update(state).digest(), bindingHash: context.bindingHash,
                    nonce, clientKey: selection.clientKey, action: selection.action,
                    accountId: context.account?.accountId ?? null, userId: context.account?.userId ?? null,
                });
                const expiresInSeconds = context.bindingExpiresAt === null ? 300
                    : Math.min(300, Math.floor((context.bindingExpiresAt - Date.now()) / 1000));
                return created === 'created' && expiresInSeconds > 0 ? { ok: true, state, nonce, expiresInSeconds }
                    : { ok: false, reason: 'BUSY' };
            } catch { return { ok: false, reason: 'UNAVAILABLE' }; }
        },
        async complete(context: ProviderAuthContext | null, input: unknown): Promise<ProviderCompletionResult> {
            if (!enabled) return { ok: false, reason: 'UNAVAILABLE' };
            const selection = inputClient(input, configuredClients);
            if (!selection || !isRecord(input) || typeof input.state !== 'string'
                || !/^[A-Za-z0-9_-]{43}$/.test(input.state) || typeof input.idToken !== 'string'
                || input.idToken.length === 0 || input.idToken.length > PROVIDER_TOKEN_MAX_LENGTH
                || Object.keys(input).filter(key => selection.client.provider === 'apple' ? key !== 'authorizationCode' : true).sort().join(',') !== ({
                    login: 'action,clientKey,idToken,state', link: 'action,clientKey,idToken,password,state',
                    signup: 'action,clientKey,idToken,state,userName', delete: 'action,clientKey,confirmation,idToken,state',
                }[selection.action])) {
                return { ok: false, reason: 'INVALID_REQUEST' };
            }
            if (selection.client.provider === 'apple' && (typeof input.authorizationCode !== 'string'
                || input.authorizationCode.length < 1 || input.authorizationCode.length > 4096
                || /[^\x21-\x7e]/u.test(input.authorizationCode))) return { ok: false, reason: 'INVALID_REQUEST' };
            const unavailable = unavailableAction(selection.action, selection.clientKey, selection.client);
            if (unavailable) return unavailable;
            if (!matchesContext(context, selection.action)) return { ok: false, reason: 'INVALID_CONTEXT' };
            if (selection.action === 'signup' && (typeof input.userName !== 'string' || input.userName.trim().length === 0
                || input.userName.trim().length > 64 || /[\u0000-\u001f\u007f]/u.test(input.userName))) {
                return { ok: false, reason: 'INVALID_USERNAME' };
            }
            if (selection.action === 'delete' && input.confirmation !== 'DELETE') return { ok: false, reason: 'INVALID_REQUEST' };
            const password = selection.action === 'link'
                ? validateLoginRequest({ user_name: 'link', user_password: input.password }) : null;
            if (password && !password.valid) return { ok: false, reason: 'INVALID_REQUEST' };
            try {
                // Consumption must commit BEFORE any provider lookup or account work.
                // Failure/cancellation requires a fresh challenge, never replay of this one.
                const attempt = await attempts.consume(
                    createHash('sha256').update(input.state).digest(), context.bindingHash,
                    selection.clientKey, selection.action);
                if (!attempt || attempt.accountId !== (context.account?.accountId ?? null)
                    || attempt.userId !== (context.account?.userId ?? null)) {
                    return { ok: false, reason: 'INVALID_ATTEMPT' };
                }
                const verified = await selection.client.verifier.verify(selection.client.provider, input.idToken, attempt.nonce);
                if (!verified.verified) return { ok: false, reason: verified.reason === 'INVALID_PROVIDER_TOKEN'
                    ? 'INVALID_PROVIDER_TOKEN' : 'UNAVAILABLE' };
                if (verified.identity.provider !== selection.client.provider) return { ok: false, reason: 'INVALID_PROVIDER_TOKEN' };
                const exchangeAppleToken = async (): Promise<string | undefined> => {
                    if (selection.client.provider !== 'apple') return undefined;
                    const tokens = await selection.client.appleTokens!.exchangeCode(input.authorizationCode as string);
                    if (!tokens || typeof tokens.refreshToken !== 'string' || tokens.refreshToken.length === 0
                        || tokens.refreshToken.length > 4096 || /[^\x21-\x7e]/u.test(tokens.refreshToken)) {
                        throw new AppleTokenClientError('INVALID_GRANT');
                    }
                    const exchanged = await selection.client.verifier.verify('apple', tokens.idToken, attempt.nonce);
                    if (!exchanged.verified) throw new AppleTokenClientError(
                        exchanged.reason === 'INVALID_PROVIDER_TOKEN' ? 'INVALID_GRANT' : 'UNAVAILABLE');
                    if (exchanged.identity.provider !== 'apple'
                        || exchanged.identity.subject !== verified.identity.subject) {
                        throw new AppleTokenClientError('INVALID_GRANT');
                    }
                    return tokens.refreshToken;
                };
                if (selection.action === 'login') {
                    const account = await accounts.find(verified.identity);
                    if (account) {
                        const token = await exchangeAppleToken();
                        if (token !== undefined) await accounts.saveAppleToken!(account, verified.identity, token);
                        return { ok: true, type: 'account-verified', account,
                            ...(verified.identity.provider === 'apple' ? { authenticationMethod: 'apple' as const } : {}) };
                    }
                    if (!signupAvailable(selection.clientKey, selection.client)) {
                        return { ok: false, reason: 'NOT_LINKED' };
                    }
                    if (verified.identity.email === undefined) return { ok: false, reason: 'INVALID_EMAIL' };
                    // This is an explicit server-authorized transition, not reuse of
                    // the consumed login state. The original cookie still expires
                    // after five minutes; completion re-verifies this same nonce.
                    const expiresInSeconds = context.bindingExpiresAt === null ? 0
                        : Math.min(300, Math.floor((context.bindingExpiresAt - Date.now()) / 1000));
                    if (expiresInSeconds <= 0) return { ok: false, reason: 'INVALID_ATTEMPT' };
                    const state = randomBytes(32).toString('base64url');
                    const created = await attempts.create({
                        stateHash: createHash('sha256').update(state).digest(), bindingHash: context.bindingHash,
                        nonce: attempt.nonce, clientKey: selection.clientKey, action: 'signup', accountId: null, userId: null,
                    });
                    return created === 'created'
                        ? { ok: true, type: 'signup-required', state, nonce: attempt.nonce, expiresInSeconds }
                        : { ok: false, reason: 'BUSY' };
                }
                if (selection.action === 'signup') {
                    if (verified.identity.email === undefined) return { ok: false, reason: 'INVALID_EMAIL' };
                    const token = await exchangeAppleToken();
                    const result = await accounts.create!(verified.identity, (input.userName as string).trim(),
                        ...(token === undefined ? [] : [token]));
                    if (!result.created && (result.reason === 'ALREADY_LINKED' || result.reason === 'DUPLICATE_USER')) {
                        // Another tab may have finished registration meanwhile.
                        // Only this verified provider subject, never its email,
                        // can resolve that race to the existing account.
                        const account = await accounts.find(verified.identity);
                        if (account && token !== undefined) await accounts.saveAppleToken!(account, verified.identity, token);
                        return account ? { ok: true, type: 'account-verified', account,
                            ...(verified.identity.provider === 'apple' ? { authenticationMethod: 'apple' as const } : {}) }
                            : { ok: false, reason: result.reason };
                    }
                    return result.created ? { ok: true, type: 'account-verified', account: result.account,
                        ...(verified.identity.provider === 'apple' ? { authenticationMethod: 'apple' as const } : {}) }
                        : { ok: false, reason: result.reason };
                }
                if (selection.action === 'delete') {
                    if (!context.account || !context.session) return { ok: false, reason: 'INVALID_CONTEXT' };
                    const token = await exchangeAppleToken();
                    const result = await accounts.delete!(context.account, verified.identity, context.session,
                        ...(token === undefined ? [] : [token]));
                    return result === 'deleted' ? { ok: true, type: 'deleted' }
                        : { ok: false, reason: result === 'not-found' ? 'ACCOUNT_GONE' : 'INVALID_PROVIDER_TOKEN' };
                }
                if (!context.account || !context.session || !password?.valid) return { ok: false, reason: 'INVALID_CONTEXT' };
                const token = await exchangeAppleToken();
                const result = await accounts.link(context.account, password.input.password, verified.identity, context.session,
                    ...(token === undefined ? [] : [token]));
                switch (result) {
                    case 'linked': case 'already-linked': return { ok: true, type: 'linked' };
                    case 'invalid-password': return { ok: false, reason: 'INVALID_PASSWORD' };
                    case 'link-conflict': return { ok: false, reason: 'LINK_CONFLICT' };
                    case 'not-found': return { ok: false, reason: 'ACCOUNT_GONE' };
                }
            } catch (error) {
                if (error instanceof AppleTokenClientError && error.code === 'INVALID_GRANT') {
                    return { ok: false, reason: 'INVALID_PROVIDER_TOKEN' };
                }
                return { ok: false, reason: selection.action === 'delete'
                    ? error instanceof AccountDeletionPendingError ? 'ACCOUNT_DELETION_PENDING' : 'ACCOUNT_DELETION_UNAVAILABLE'
                    : 'UNAVAILABLE' };
            }
        },
    };
}
