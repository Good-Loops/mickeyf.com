import { createHash, randomBytes } from 'node:crypto';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import type { ProviderAuthClient } from '../auth/providerAuthFlow';
import type { VerifiedProviderIdentity } from '../auth/providerIdentity';
import { PROVIDER_TOKEN_MAX_LENGTH } from '../auth/providerTokenVerifier';
import { isRecord } from '../security/userRequestValidation';

const LIFETIME_MS = 5 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const ACCOUNT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const hash = (value: string) => createHash('sha256').update(value).digest();
const keys = (value: Record<string, unknown>, expected: string) => Object.keys(value).sort().join(',') === expected;

/** Supplied only after the country's provider-only assurance and exact consent text are reviewed. */
export type ParentRegistrationPolicy = Readonly<{
    version: string;
    consentVersion: string;
    consentText: string;
    countries: readonly string[];
    creationEnabled?: boolean;
}>;
export type ParentOperation = Readonly<{ purpose: 'create-child'; country: string }>
    | Readonly<{ purpose: 'withdraw-child'; childAccountId: string }>;
export type ParentChallenge = Readonly<{
    stateHash: Buffer; bindingHash: Buffer; parentAccountId: string; parentUserId: number;
    clientKey: string; nonce: string; policyDigest: Buffer; expiresAt: number;
    operation: ParentOperation;
}>;
export type ParentGrant = ParentChallenge & Readonly<{
    grantHash: Buffer; identity: VerifiedProviderIdentity; consentVersion: string; policyVersion: string;
}>;
export type ParentChild = Readonly<{ accountId: string; userName: string; scoreVisibility: 'private' }>;
export type ParentCredentials = Readonly<{ userName: string; password: string }>;
export type ParentFailure = Readonly<{ error: 'CLOSED' | 'INVALID_REQUEST' | 'INVALID_CONTEXT' | 'INVALID_ATTEMPT'
    | 'INVALID_PROVIDER_TOKEN' | 'PROVIDER_NOT_LINKED' | 'VERIFIED_CONTACT_REQUIRED' | 'UNAVAILABLE' }>;

/**
 * Persistent implementation is mandatory before mounting the HTTP router. In particular:
 * - consumeChallenge commits before external verification; approve must reject cancelled/expired attempts.
 * - createChild locks and revalidates the parent session, provider link, policy, grant and expiry,
 *   then inserts a distinct child, private profile and consent while consuming the grant in ONE transaction.
 * - withdrawChild authorizes the same parent's exact child, persists the independent deletion journal
 *   before deletion, revokes child sessions, and serializes with score submission. It never deletes the parent.
 * - cancellation is a tombstone through expiry, including while provider verification is in flight.
 * None of these methods may establish or replace a browser's login session.
 */
export type ParentRegistrationStore = {
    begin(challenge: ParentChallenge, context: ProviderAuthContext): Promise<boolean>;
    consumeChallenge(stateHash: Buffer, context: ProviderAuthContext): Promise<ParentChallenge | null>;
    isLinkedParent(context: ProviderAuthContext, identity: VerifiedProviderIdentity): Promise<boolean>;
    approve(grant: ParentGrant, context: ProviderAuthContext): Promise<boolean>;
    cancel(stateHash: Buffer, context: ProviderAuthContext): Promise<void>;
    createChild(grantHash: Buffer, context: ProviderAuthContext, policyDigest: Buffer,
        credentials: ParentCredentials): Promise<ParentChild>;
    withdrawChild(grantHash: Buffer, context: ProviderAuthContext, policyDigest: Buffer): Promise<void>;
    listChildren(context: ProviderAuthContext): Promise<ParentChild[]>;
};

function authenticated(context: ProviderAuthContext | null): context is ProviderAuthContext {
    return !!context?.account && !!context.session && context.account.accountId === context.session.accountId
        && ACCOUNT.test(context.account.accountId) && Number.isSafeInteger(context.account.userId)
        && context.account.userId > 0 && TOKEN.test(context.session.sessionId)
        && Buffer.isBuffer(context.bindingHash) && context.bindingHash.length === 32;
}

function readPolicy(policy: ParentRegistrationPolicy | undefined) {
    if (!policy) return undefined;
    if (![policy.version, policy.consentVersion].every(value => /^[A-Za-z0-9._-]{1,64}$/u.test(value))
        || typeof policy.consentText !== 'string' || policy.consentText.trim().length < 1 || policy.consentText.length > 8000
        || !Array.isArray(policy.countries) || policy.countries.length < 1 || policy.countries.length > 249
        || policy.countries.some(value => !/^[A-Z]{2}$/u.test(value))
        || new Set(policy.countries).size !== policy.countries.length) throw new TypeError('Invalid reviewed parent registration policy.');
    const copy = Object.freeze({ ...policy, countries: Object.freeze([...policy.countries].sort()) });
    return { ...copy, digest: hash(JSON.stringify([copy.version, copy.consentVersion, copy.consentText, copy.countries])) };
}

function readOperation(input: Record<string, unknown>, policy: ParentRegistrationPolicy): ParentOperation | null {
    if (input.purpose === 'withdraw-child') {
        return keys(input, 'childAccountId,clientKey,confirmation,policyVersion,purpose')
            && input.confirmation === 'WITHDRAW AND DELETE' && typeof input.childAccountId === 'string'
            && ACCOUNT.test(input.childAccountId) ? { purpose: 'withdraw-child', childAccountId: input.childAccountId } : null;
    }
    if (input.purpose !== 'create-child' || !keys(input, 'adultAttestation,clientKey,consent,consentVersion,country,guardianAttestation,policyVersion,purpose')
        || input.adultAttestation !== true || input.guardianAttestation !== true || input.consent !== true
        || input.consentVersion !== policy.consentVersion || typeof input.country !== 'string'
        || !policy.countries.includes(input.country)) return null;
    return { purpose: 'create-child', country: input.country };
}

export function createParentRegistrationFlow({ policy: inputPolicy, clients, store, now = Date.now }: {
    policy?: ParentRegistrationPolicy;
    clients: Readonly<Record<string, ProviderAuthClient>>;
    store: ParentRegistrationStore;
    now?: () => number;
}) {
    const policy = readPolicy(inputPolicy);
    const configuredClients = new Map(Object.entries(clients).filter(([key, value]) =>
        (['google-web', 'google-ios', 'google-android'].includes(key) && value.provider === 'google')
        || (['apple-web', 'apple-ios'].includes(key) && value.provider === 'apple')));
    const failure = (error: ParentFailure['error']): ParentFailure => ({ error });
    return {
        config() {
            return policy ? { enabled: true as const, policyVersion: policy.version, consentVersion: policy.consentVersion,
                consentText: policy.consentText, countries: [...policy.countries], creationEnabled: policy.creationEnabled !== false } : { enabled: false as const };
        },
        async begin(context: ProviderAuthContext | null, input: unknown) {
            if (!policy) return failure('CLOSED');
            if (!authenticated(context)) return failure('INVALID_CONTEXT');
            if (!isRecord(input) || input.policyVersion !== policy.version || typeof input.clientKey !== 'string'
                || !configuredClients.has(input.clientKey)) return failure('INVALID_REQUEST');
            const operation = readOperation(input, policy);
            if (operation?.purpose === 'create-child' && policy.creationEnabled === false) return failure('CLOSED');
            if (!operation || (operation.purpose === 'withdraw-child' && operation.childAccountId === context.account!.accountId)) {
                return failure('INVALID_REQUEST');
            }
            const state = randomBytes(32).toString('base64url');
            const nonce = randomBytes(32).toString('base64url');
            try {
                const saved = await store.begin({ stateHash: hash(state), nonce, bindingHash: context.bindingHash,
                    parentAccountId: context.account!.accountId, parentUserId: context.account!.userId,
                    clientKey: input.clientKey, policyDigest: policy.digest, expiresAt: now() + LIFETIME_MS, operation }, context);
                return saved ? { state, nonce, expiresInSeconds: 300 } : failure('UNAVAILABLE');
            } catch { return failure('UNAVAILABLE'); }
        },
        async complete(context: ProviderAuthContext | null, input: unknown) {
            if (!policy) return failure('CLOSED');
            if (!authenticated(context)) return failure('INVALID_CONTEXT');
            if (!isRecord(input) || !keys(input, 'idToken,state') || typeof input.state !== 'string' || !TOKEN.test(input.state)
                || typeof input.idToken !== 'string' || !input.idToken || input.idToken.length > PROVIDER_TOKEN_MAX_LENGTH) {
                return failure('INVALID_REQUEST');
            }
            try {
                const attempt = await store.consumeChallenge(hash(input.state), context);
                if (!attempt || !attempt.bindingHash.equals(context.bindingHash) || !attempt.policyDigest.equals(policy.digest)
                    || attempt.parentAccountId !== context.account!.accountId || attempt.parentUserId !== context.account!.userId
                    || attempt.expiresAt <= now()) return failure('INVALID_ATTEMPT');
                const client = configuredClients.get(attempt.clientKey);
                if (!client) return failure('INVALID_ATTEMPT');
                const proof = await client.verifier.verify(client.provider, input.idToken, attempt.nonce);
                if (!proof.verified) return failure(proof.reason === 'INVALID_PROVIDER_TOKEN' ? 'INVALID_PROVIDER_TOKEN' : 'UNAVAILABLE');
                if (proof.identity.provider !== client.provider) return failure('INVALID_PROVIDER_TOKEN');
                if (!await store.isLinkedParent(context, proof.identity)) return failure('PROVIDER_NOT_LINKED');
                // Provider-signed contact evidence is distinct from both guardian authority and adult attestation.
                // Withdrawal remains available if the provider omits email on a later sign-in.
                if (attempt.operation.purpose === 'create-child' && !proof.identity.email) return failure('VERIFIED_CONTACT_REQUIRED');
                if (attempt.expiresAt <= now()) return failure('INVALID_ATTEMPT');
                const grant = randomBytes(32).toString('base64url');
                const approved = await store.approve({ ...attempt, grantHash: hash(grant), identity: proof.identity,
                    consentVersion: policy.consentVersion, policyVersion: policy.version }, context);
                const remaining = Math.floor((attempt.expiresAt - now()) / 1000);
                return approved && remaining > 0 ? { grant, purpose: attempt.operation.purpose, expiresInSeconds: remaining }
                    : failure('INVALID_ATTEMPT');
            } catch { return failure('UNAVAILABLE'); }
        },
        async cancel(context: ProviderAuthContext | null, input: unknown) {
            if (!authenticated(context)) return failure('INVALID_CONTEXT');
            if (!isRecord(input) || !keys(input, 'state') || typeof input.state !== 'string' || !TOKEN.test(input.state)) return failure('INVALID_REQUEST');
            try { await store.cancel(hash(input.state), context); return { cancelled: true as const }; }
            catch { return failure('UNAVAILABLE'); }
        },
        async createChild(context: ProviderAuthContext | null, input: unknown) {
            if (!policy || policy.creationEnabled === false) return failure('CLOSED');
            if (!authenticated(context)) return failure('INVALID_CONTEXT');
            if (!isRecord(input) || !keys(input, 'grant,password,userName') || typeof input.grant !== 'string' || !TOKEN.test(input.grant)
                || typeof input.userName !== 'string' || !input.userName.trim() || input.userName.trim().length > 64
                || /[\u0000-\u001f\u007f]/u.test(input.userName) || typeof input.password !== 'string'
                || input.password.length < 8 || Buffer.byteLength(input.password, 'utf8') > 72
                || /[\u0000-\u001f\u007f]/u.test(input.password)) return failure('INVALID_REQUEST');
            try {
                const child = await store.createChild(hash(input.grant), context, policy.digest,
                    { userName: input.userName.trim(), password: input.password });
                if (child.scoreVisibility !== 'private' || child.accountId === context.account!.accountId
                    || !ACCOUNT.test(child.accountId)) return failure('UNAVAILABLE');
                return { created: true as const, child };
            } catch { return failure('UNAVAILABLE'); }
        },
        async withdrawChild(context: ProviderAuthContext | null, input: unknown) {
            if (!policy) return failure('CLOSED');
            if (!authenticated(context)) return failure('INVALID_CONTEXT');
            if (!isRecord(input) || !keys(input, 'confirmation,grant') || input.confirmation !== 'WITHDRAW AND DELETE'
                || typeof input.grant !== 'string' || !TOKEN.test(input.grant)) return failure('INVALID_REQUEST');
            try { await store.withdrawChild(hash(input.grant), context, policy.digest); return { deleted: true as const }; }
            catch { return failure('UNAVAILABLE'); }
        },
        async listChildren(context: ProviderAuthContext | null, input: unknown) {
            if (!policy) return failure('CLOSED');
            if (!authenticated(context)) return failure('INVALID_CONTEXT');
            if (!isRecord(input) || Object.keys(input).length) return failure('INVALID_REQUEST');
            try { return { children: await store.listChildren(context) }; } catch { return failure('UNAVAILABLE'); }
        },
    };
}
export type ParentRegistrationFlow = ReturnType<typeof createParentRegistrationFlow>;
