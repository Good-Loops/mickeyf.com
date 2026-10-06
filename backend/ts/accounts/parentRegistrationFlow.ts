import { createHash, randomBytes } from 'node:crypto';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import type { ProviderAuthClient } from '../auth/providerAuthFlow';
import type { VerifiedProviderIdentity } from '../auth/providerIdentity';
import { PROVIDER_TOKEN_MAX_LENGTH } from '../auth/providerTokenVerifier';
import { isRecord } from '../security/userRequestValidation';
import type { ScoreParticipationPolicy } from '../config/scoreParticipationPolicy';
import { familySelectionDigest } from './familyDeletionSelection';
import { parsePrivacyNoticeUrl } from '../config/privacyNoticeUrl';
import { SIGNED_FORM_VERSION, signedFormNoticeDigest, signedFormRequired, SignedParentFormRequiredError, type SignedParentFormRequest } from './signedParentForm';

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
    privacyNoticeUrl: string;
    countries: readonly string[];
    creationEnabled?: boolean;
    signedFormsEnabled?: boolean;
}>;
export type ParentOperation = Readonly<{ purpose: 'create-child'; country: string }>
    | Readonly<{ purpose: 'withdraw-child'; childAccountId: string }>
    | Readonly<{ purpose: 'delete-family'; familyDigest: Buffer }>
    | Readonly<{ purpose: 'publish-scores'; childAccountId: string }>;
export type ParentChallenge = Readonly<{
    stateHash: Buffer; bindingHash: Buffer; parentAccountId: string; parentUserId: number;
    clientKey: string; nonce: string; policyDigest: Buffer; expiresAt: number;
    operation: ParentOperation;
}>;
export type ParentGrant = ParentChallenge & Readonly<{
    grantHash: Buffer; identity: VerifiedProviderIdentity; consentVersion: string; policyVersion: string;
}>;
export type ParentChild = Readonly<{ accountId: string; userName: string; scoreVisibility: 'private' }>;
export type ParentCredentials = Readonly<{ userName: string; password: string; formReference?: string }>;
export type ParentFailure = Readonly<{ error: 'CLOSED' | 'INVALID_REQUEST' | 'INVALID_CONTEXT' | 'INVALID_ATTEMPT'
    | 'INVALID_PROVIDER_TOKEN' | 'PROVIDER_NOT_LINKED' | 'VERIFIED_CONTACT_REQUIRED' | 'SIGNED_FORM_REQUIRED' | 'UNAVAILABLE' }>;

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
    publishScores?(grantHash: Buffer, context: ProviderAuthContext, policyDigest: Buffer): Promise<void>;
    withdrawScores?(context: ProviderAuthContext, targetAccountId: string): Promise<void>;
    scoreStatus?(context: ProviderAuthContext, targetAccountId: string): Promise<{ visibility: 'public' | 'private'; canPublish: boolean }>;
    deleteFamily?(grantHash: Buffer, context: ProviderAuthContext, policyDigest: Buffer, familyDigest: Buffer): Promise<void>;
    listChildren(context: ProviderAuthContext): Promise<ParentChild[]>;
    requestSignedForm?(challenge: ParentChallenge, identity: VerifiedProviderIdentity, context: ProviderAuthContext,
        userName: string, policy: ParentRegistrationPolicy): Promise<SignedParentFormRequest>;
    listSignedForms?(context: ProviderAuthContext, policyDigest: Buffer): Promise<SignedParentFormRequest[]>;
    cancelSignedForm?(context: ProviderAuthContext, reference: string): Promise<void>;
};

function authenticated(context: ProviderAuthContext | null): context is ProviderAuthContext {
    return !!context?.account && !!context.session && context.account.accountId === context.session.accountId
        && ACCOUNT.test(context.account.accountId) && Number.isSafeInteger(context.account.userId)
        && context.account.userId > 0 && TOKEN.test(context.session.sessionId)
        && Buffer.isBuffer(context.bindingHash) && context.bindingHash.length === 32;
}

function readPolicy(policy: ParentRegistrationPolicy | undefined) {
    if (!policy) return undefined;
    const privacyNoticeUrl = parsePrivacyNoticeUrl(policy.privacyNoticeUrl);
    if (![policy.version, policy.consentVersion].every(value => /^[A-Za-z0-9._-]{1,64}$/u.test(value))
        || !privacyNoticeUrl || typeof policy.consentText !== 'string' || policy.consentText.trim().length < 1 || policy.consentText.length > 8000
        || !Array.isArray(policy.countries) || policy.countries.length < 1 || policy.countries.length > 249
        || policy.countries.some(value => !/^[A-Z]{2}$/u.test(value))
        || new Set(policy.countries).size !== policy.countries.length) throw new TypeError('Invalid reviewed parent registration policy.');
    const copy = Object.freeze({ ...policy, privacyNoticeUrl, countries: Object.freeze([...policy.countries].sort()) });
    const terms = [copy.version, copy.consentVersion, copy.consentText, copy.privacyNoticeUrl, copy.countries];
    if (copy.signedFormsEnabled) terms.push(signedFormNoticeDigest().toString('hex'));
    return { ...copy, digest: hash(JSON.stringify(terms)) };
}

function readOperation(input: Record<string, unknown>, policy: ParentRegistrationPolicy): ParentOperation | null {
    if (input.purpose === 'delete-family') {
        const digest = familySelectionDigest(input.childAccountIds);
        return keys(input, 'childAccountIds,clientKey,confirmation,policyVersion,purpose')
            && input.confirmation === 'DELETE MY FAMILY' && digest ? { purpose: 'delete-family', familyDigest: digest } : null;
    }
    if (input.purpose === 'withdraw-child') {
        return keys(input, 'childAccountId,clientKey,confirmation,policyVersion,purpose')
            && input.confirmation === 'WITHDRAW AND DELETE' && typeof input.childAccountId === 'string'
            && ACCOUNT.test(input.childAccountId) ? { purpose: 'withdraw-child', childAccountId: input.childAccountId } : null;
    }
    if (input.purpose !== 'create-child' || !keys(input, 'adultAttestation,clientKey,consent,consentVersion,country,guardianAttestation,policyVersion,privacyNoticeUrl,purpose')
        || input.adultAttestation !== true || input.guardianAttestation !== true || input.consent !== true
        || input.consentVersion !== policy.consentVersion || input.privacyNoticeUrl !== policy.privacyNoticeUrl || typeof input.country !== 'string'
        || !policy.countries.includes(input.country)) return null;
    return { purpose: 'create-child', country: input.country };
}

export function createParentRegistrationFlow({ policy: inputPolicy, publicationPolicy, clients, store, now = Date.now }: {
    policy?: ParentRegistrationPolicy;
    publicationPolicy?: ScoreParticipationPolicy;
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
                consentText: policy.consentText, privacyNoticeUrl: policy.privacyNoticeUrl,
                countries: [...policy.countries], creationEnabled: policy.creationEnabled !== false,
                ...(policy.signedFormsEnabled ? { signedFormCountries: ['US'], signedFormVersion: SIGNED_FORM_VERSION } : {}) } : { enabled: false as const };
        },
        async begin(context: ProviderAuthContext | null, input: unknown) {
            const publishing = isRecord(input) && input.purpose === 'publish-scores';
            const operationPolicy = publishing ? publicationPolicy : policy;
            if (!operationPolicy) return failure('CLOSED');
            if (!authenticated(context)) return failure('INVALID_CONTEXT');
            if (!isRecord(input) || input.policyVersion !== operationPolicy.version || typeof input.clientKey !== 'string'
                || !configuredClients.has(input.clientKey)) return failure('INVALID_REQUEST');
            const operation: ParentOperation | null = publishing
                ? keys(input, 'childAccountId,clientKey,consentText,consentVersion,participation,policyVersion,privacyNoticeUrl,purpose')
                    && input.participation === true && input.consentText === publicationPolicy!.consentText && input.consentVersion === publicationPolicy!.consentVersion
                    && input.privacyNoticeUrl === publicationPolicy!.privacyNoticeUrl
                    && (input.childAccountId === null || typeof input.childAccountId === 'string' && ACCOUNT.test(input.childAccountId))
                    ? { purpose: 'publish-scores', childAccountId: input.childAccountId as string | null ?? context.account!.accountId } : null
                : readOperation(input, policy!);
            if (operation?.purpose === 'create-child' && policy?.creationEnabled === false) return failure('CLOSED');
            if (operation?.purpose === 'create-child' && signedFormRequired(operation.country) && !policy?.signedFormsEnabled) return failure('CLOSED');
            if (!operation || (operation.purpose === 'withdraw-child' && operation.childAccountId === context.account!.accountId)) {
                return failure('INVALID_REQUEST');
            }
            const state = randomBytes(32).toString('base64url');
            const nonce = randomBytes(32).toString('base64url');
            try {
                const saved = await store.begin({ stateHash: hash(state), nonce, bindingHash: context.bindingHash,
                    parentAccountId: context.account!.accountId, parentUserId: context.account!.userId,
                    clientKey: input.clientKey, policyDigest: operationPolicy.digest, expiresAt: now() + LIFETIME_MS, operation }, context);
                return saved ? { state, nonce, expiresInSeconds: 300 } : failure('UNAVAILABLE');
            } catch { return failure('UNAVAILABLE'); }
        },
        async complete(context: ProviderAuthContext | null, input: unknown) {
            if (!policy && !publicationPolicy) return failure('CLOSED');
            if (!authenticated(context)) return failure('INVALID_CONTEXT');
            if (!isRecord(input) || !keys(input, 'idToken,state') || typeof input.state !== 'string' || !TOKEN.test(input.state)
                || typeof input.idToken !== 'string' || !input.idToken || input.idToken.length > PROVIDER_TOKEN_MAX_LENGTH) {
                return failure('INVALID_REQUEST');
            }
            try {
                const attempt = await store.consumeChallenge(hash(input.state), context);
                const operationPolicy = attempt?.operation.purpose === 'publish-scores' ? publicationPolicy : policy;
                if (!attempt || !operationPolicy || !attempt.bindingHash.equals(context.bindingHash) || !attempt.policyDigest.equals(operationPolicy.digest)
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
                    consentVersion: operationPolicy.consentVersion, policyVersion: operationPolicy.version }, context);
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
            if (!policy || policy?.creationEnabled === false) return failure('CLOSED');
            if (!authenticated(context)) return failure('INVALID_CONTEXT');
            if (!isRecord(input) || !(keys(input, 'grant,password,userName') || keys(input, 'formReference,grant,password,userName'))
                || (input.formReference !== undefined && (typeof input.formReference !== 'string' || !ACCOUNT.test(input.formReference)))
                || typeof input.grant !== 'string' || !TOKEN.test(input.grant)
                || typeof input.userName !== 'string' || !input.userName.trim() || input.userName.trim().length > 64
                || /[\u0000-\u001f\u007f]/u.test(input.userName) || typeof input.password !== 'string'
                || input.password.length < 8 || Buffer.byteLength(input.password, 'utf8') > 72
                || /[\u0000-\u001f\u007f]/u.test(input.password)) return failure('INVALID_REQUEST');
            try {
                const child = await store.createChild(hash(input.grant), context, policy.digest,
                    { userName: input.userName.trim(), password: input.password, ...(input.formReference ? { formReference: input.formReference as string } : {}) });
                if (child.scoreVisibility !== 'private' || child.accountId === context.account!.accountId
                    || !ACCOUNT.test(child.accountId)) return failure('UNAVAILABLE');
                return { created: true as const, child };
            } catch (error) { return failure(error instanceof SignedParentFormRequiredError ? 'SIGNED_FORM_REQUIRED' : 'UNAVAILABLE'); }
        },
        async requestSignedForm(context: ProviderAuthContext | null, input: unknown) {
            if (!policy?.signedFormsEnabled || policy.creationEnabled === false || !store.requestSignedForm) return failure('CLOSED');
            if (!authenticated(context)) return failure('INVALID_CONTEXT');
            if (!isRecord(input) || !keys(input, 'idToken,state,userName') || typeof input.state !== 'string' || !TOKEN.test(input.state)
                || typeof input.idToken !== 'string' || !input.idToken || input.idToken.length > PROVIDER_TOKEN_MAX_LENGTH
                || typeof input.userName !== 'string' || !input.userName.trim() || input.userName.trim().length > 64
                || /[\u0000-\u001f\u007f]/u.test(input.userName)) return failure('INVALID_REQUEST');
            try {
                const attempt = await store.consumeChallenge(hash(input.state), context);
                if (!attempt || !attempt.bindingHash.equals(context.bindingHash) || !attempt.policyDigest.equals(policy.digest)
                    || attempt.parentAccountId !== context.account!.accountId || attempt.parentUserId !== context.account!.userId
                    || attempt.expiresAt <= now() || attempt.operation.purpose !== 'create-child'
                    || !signedFormRequired(attempt.operation.country)) return failure('INVALID_ATTEMPT');
                const client = configuredClients.get(attempt.clientKey);
                if (!client) return failure('INVALID_ATTEMPT');
                const proof = await client.verifier.verify(client.provider, input.idToken, attempt.nonce);
                if (!proof.verified) return failure(proof.reason === 'INVALID_PROVIDER_TOKEN' ? 'INVALID_PROVIDER_TOKEN' : 'UNAVAILABLE');
                if (proof.identity.provider !== client.provider) return failure('INVALID_PROVIDER_TOKEN');
                if (!await store.isLinkedParent(context, proof.identity)) return failure('PROVIDER_NOT_LINKED');
                if (!proof.identity.email) return failure('VERIFIED_CONTACT_REQUIRED');
                if (attempt.expiresAt <= now()) return failure('INVALID_ATTEMPT');
                const form = await store.requestSignedForm(attempt, proof.identity, context, input.userName.trim(), policy);
                return { form };
            } catch { return failure('UNAVAILABLE'); }
        },
        async listSignedForms(context: ProviderAuthContext | null, input: unknown) {
            if (!policy?.signedFormsEnabled || !store.listSignedForms) return failure('CLOSED');
            if (!authenticated(context)) return failure('INVALID_CONTEXT');
            if (!isRecord(input) || Object.keys(input).length) return failure('INVALID_REQUEST');
            try { return { forms: await store.listSignedForms(context, policy.digest) }; }
            catch { return failure('UNAVAILABLE'); }
        },
        async cancelSignedForm(context: ProviderAuthContext | null, input: unknown) {
            if (!policy?.signedFormsEnabled || !store.cancelSignedForm) return failure('CLOSED');
            if (!authenticated(context)) return failure('INVALID_CONTEXT');
            if (!isRecord(input) || !keys(input, 'reference') || typeof input.reference !== 'string' || !ACCOUNT.test(input.reference)) return failure('INVALID_REQUEST');
            try { await store.cancelSignedForm(context, input.reference); return { cancelled: true as const }; }
            catch { return failure('UNAVAILABLE'); }
        },
        async withdrawChild(context: ProviderAuthContext | null, input: unknown) {
            if (!policy) return failure('CLOSED');
            if (!authenticated(context)) return failure('INVALID_CONTEXT');
            if (!isRecord(input) || !keys(input, 'confirmation,grant') || input.confirmation !== 'WITHDRAW AND DELETE'
                || typeof input.grant !== 'string' || !TOKEN.test(input.grant)) return failure('INVALID_REQUEST');
            try { await store.withdrawChild(hash(input.grant), context, policy.digest); return { deleted: true as const }; }
            catch { return failure('UNAVAILABLE'); }
        },
        scoreConfig() {
            return publicationPolicy ? { enabled: true as const, policyVersion: publicationPolicy.version,
                consentVersion: publicationPolicy.consentVersion, consentText: publicationPolicy.consentText,
                privacyNoticeUrl: publicationPolicy.privacyNoticeUrl } : { enabled: false as const };
        },
        async publishScores(context: ProviderAuthContext | null, input: unknown) {
            if (!publicationPolicy || !store.publishScores) return failure('CLOSED');
            if (!authenticated(context)) return failure('INVALID_CONTEXT');
            if (!isRecord(input) || !keys(input, 'grant') || typeof input.grant !== 'string' || !TOKEN.test(input.grant)) return failure('INVALID_REQUEST');
            try { await store.publishScores(hash(input.grant), context, publicationPolicy.digest); return { visibility: 'public' as const }; }
            catch { return failure('UNAVAILABLE'); }
        },
        async withdrawScores(context: ProviderAuthContext | null, input: unknown) {
            if (!store.withdrawScores) return failure('CLOSED');
            if (!authenticated(context)) return failure('INVALID_CONTEXT');
            if (!isRecord(input) || !keys(input, 'childAccountId') || !(input.childAccountId === null
                || typeof input.childAccountId === 'string' && ACCOUNT.test(input.childAccountId))) return failure('INVALID_REQUEST');
            try { await store.withdrawScores(context, input.childAccountId as string | null ?? context.account!.accountId); return { visibility: 'private' as const }; }
            catch { return failure('UNAVAILABLE'); }
        },
        async scoreStatus(context: ProviderAuthContext | null, input: unknown) {
            if (!store.scoreStatus) return failure('CLOSED');
            if (!authenticated(context)) return failure('INVALID_CONTEXT');
            if (!isRecord(input) || !keys(input, 'childAccountId') || !(input.childAccountId === null
                || typeof input.childAccountId === 'string' && ACCOUNT.test(input.childAccountId))) return failure('INVALID_REQUEST');
            try { return await store.scoreStatus(context, input.childAccountId as string | null ?? context.account!.accountId); }
            catch { return failure('UNAVAILABLE'); }
        },
        async deleteFamily(context: ProviderAuthContext | null, input: unknown) {
            if (!policy || !store.deleteFamily) return failure('CLOSED');
            if (!authenticated(context)) return failure('INVALID_CONTEXT');
            const digest = isRecord(input) ? familySelectionDigest(input.childAccountIds) : null;
            if (!isRecord(input) || !keys(input, 'childAccountIds,confirmation,grant') || !digest
                || input.confirmation !== 'DELETE MY FAMILY' || typeof input.grant !== 'string' || !TOKEN.test(input.grant)) {
                return failure('INVALID_REQUEST');
            }
            try { await store.deleteFamily(hash(input.grant), context, policy.digest, digest); return { deleted: true as const }; }
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
