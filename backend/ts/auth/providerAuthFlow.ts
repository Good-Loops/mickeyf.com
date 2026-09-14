import { createHash, randomBytes } from 'node:crypto';
import type { AccountLinkTarget, ProviderAccount, ProviderLinkResult } from '../accounts/providerAccountRepository';
import { isRecord, validateLoginRequest } from '../security/userRequestValidation';
import type { SessionProof } from '../security/sessionPolicy';
import type { ProviderAuthContext } from './providerAuthContext';
import type { ProviderAttempt, ConsumedProviderAttempt, ProviderAttemptAction, ProviderAttemptCreateResult } from './providerAttemptRepository';
import type { IdentityProvider, VerifiedProviderIdentity } from './providerIdentity';
import { type ProviderTokenVerifier, PROVIDER_TOKEN_MAX_LENGTH } from './providerTokenVerifier';

export type ProviderAuthClient = Readonly<{ provider: IdentityProvider; verifier: ProviderTokenVerifier }>;
type Failure = { ok: false; reason: 'UNAVAILABLE' | 'INVALID_REQUEST' | 'INVALID_CONTEXT'
    | 'BUSY' | 'INVALID_ATTEMPT' | 'INVALID_PROVIDER_TOKEN' | 'NOT_LINKED' | 'INVALID_PASSWORD'
    | 'LINK_CONFLICT' | 'ACCOUNT_GONE' };
export type ProviderChallengeResult = Failure | { ok: true; state: string; nonce: string; expiresInSeconds: number };
export type ProviderCompletionResult = Failure
    | { ok: true; type: 'account-verified'; account: ProviderAccount }
    | { ok: true; type: 'linked' };

export type ProviderAuthFlowDependencies = {
    attempts: {
        create(attempt: ProviderAttempt): Promise<ProviderAttemptCreateResult>;
        consume(stateHash: Buffer, bindingHash: Buffer, clientKey: string, action: ProviderAttemptAction): Promise<ConsumedProviderAttempt | null>;
    };
    accounts: {
        find(identity: VerifiedProviderIdentity): Promise<ProviderAccount | null>;
        link(target: AccountLinkTarget, password: string, identity: VerifiedProviderIdentity, session: SessionProof): Promise<ProviderLinkResult>;
    };
    clients: Readonly<Record<string, ProviderAuthClient>>;
    enabled?: boolean;
};

function inputClient(input: unknown, clients: ReadonlyMap<string, ProviderAuthClient>) {
    if (!isRecord(input) || typeof input.clientKey !== 'string'
        || (input.action !== 'login' && input.action !== 'link')) return null;
    const client = clients.get(input.clientKey);
    return client ? { client, clientKey: input.clientKey, action: input.action as 'login' | 'link' } : null;
}

function matchesContext(context: ProviderAuthContext | null, action: 'login' | 'link'): context is ProviderAuthContext {
    return context !== null && Buffer.isBuffer(context.bindingHash) && context.bindingHash.length === 32
        && (action === 'login' ? context.account === null && context.session === null
            : context.account !== null && context.session !== null);
}

/**
 * ID-token workflow; the opt-in HTTP adapter owns session issuance.
 * `account-verified` is an internal decision, NOT a login session or browser proof.
 */
export function createProviderAuthFlow({ attempts, accounts, clients, enabled = false }: ProviderAuthFlowDependencies) {
    // A Map excludes inherited names such as __proto__, and captures server configuration once.
    const configuredClients = new Map(Object.entries(clients).map(([key, client]) => {
        if (!/^[a-z0-9_-]{1,64}$/.test(key) || !['google', 'apple'].includes(client.provider)
            || typeof client.verifier?.verify !== 'function') throw new TypeError('Invalid provider client configuration.');
        return [key, Object.freeze({ ...client })] as const;
    }));
    return {
        async begin(context: ProviderAuthContext | null, input: unknown): Promise<ProviderChallengeResult> {
            if (!enabled) return { ok: false, reason: 'UNAVAILABLE' };
            const selection = inputClient(input, configuredClients);
            if (!selection || !isRecord(input) || Object.keys(input).sort().join(',') !== 'action,clientKey') {
                return { ok: false, reason: 'INVALID_REQUEST' };
            }
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
                || Object.keys(input).sort().join(',') !== (selection.action === 'link'
                    ? 'action,clientKey,idToken,password,state' : 'action,clientKey,idToken,state')) {
                return { ok: false, reason: 'INVALID_REQUEST' };
            }
            if (!matchesContext(context, selection.action)) return { ok: false, reason: 'INVALID_CONTEXT' };
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
                if (selection.action === 'login') {
                    const account = await accounts.find(verified.identity);
                    return account ? { ok: true, type: 'account-verified', account } : { ok: false, reason: 'NOT_LINKED' };
                }
                if (!context.account || !context.session || !password?.valid) return { ok: false, reason: 'INVALID_CONTEXT' };
                const result = await accounts.link(context.account, password.input.password, verified.identity, context.session);
                switch (result) {
                    case 'linked': case 'already-linked': return { ok: true, type: 'linked' };
                    case 'invalid-password': return { ok: false, reason: 'INVALID_PASSWORD' };
                    case 'link-conflict': return { ok: false, reason: 'LINK_CONFLICT' };
                    case 'not-found': return { ok: false, reason: 'ACCOUNT_GONE' };
                }
            } catch { return { ok: false, reason: 'UNAVAILABLE' }; }
        },
    };
}
