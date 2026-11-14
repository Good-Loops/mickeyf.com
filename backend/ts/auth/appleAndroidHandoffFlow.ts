import { createHash } from 'node:crypto';
import type { ProviderAuthContext } from './providerAuthContext';
import type { ProviderAttemptAction } from './providerAttemptRepository';
import type { ProviderTokenVerifier } from './providerTokenVerifier';
import type { createAppleAndroidHandoffRepository } from './appleAndroidHandoffRepository';
import type { AppleAndroidHandoffBinding } from './appleAndroidHandoffCrypto';
import { AppleAndroidHandoffError } from './appleAndroidHandoffCrypto';
import { APPLE_ANDROID_RETURN_URI } from '../config/appleAndroidConfig';
import { isRecord } from '../security/userRequestValidation';

type Store = ReturnType<typeof createAppleAndroidHandoffRepository>;
function validState(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value)
        && Buffer.from(value, 'base64url').toString('base64url') === value;
}
function stateHash(state: string) { return createHash('sha256').update(state).digest(); }
function contextMatches(context: ProviderAuthContext | null, binding: AppleAndroidHandoffBinding): boolean {
    return context !== null && context.bindingHash.equals(binding.bindingHash)
        && binding.accountId === (context.account?.accountId ?? null) && binding.userId === (context.account?.userId ?? null)
        && ((binding.action === 'login' || binding.action === 'signup') ? context.session === null && context.account === null
            : context.account !== null && context.session !== null);
}
function returnUrl(state: string, result: 'ready' | 'cancelled') {
    return `${APPLE_ANDROID_RETURN_URI}#state=${state}&result=${result}`;
}

/** The return carries an opaque bound proof, never provider credentials or the native session cookie. */
export function createAppleAndroidHandoffFlow(store: Store, verifier: ProviderTokenVerifier, now = Date.now) {
    return Object.freeze({
        async prepare(context: ProviderAuthContext, challenge: { state: string; nonce: string; expiresInSeconds: number },
            action: ProviderAttemptAction): Promise<boolean> {
            if (!validState(challenge.state)) return false;
            const attempt = await store.readAttempt(stateHash(challenge.state), context.bindingHash);
            if (!attempt || attempt.nonce !== challenge.nonce || attempt.action !== action || !contextMatches(context, attempt)) return false;
            // Link/delete use an authenticated cookie without a five-minute deadline. The original SQL expiry
            // still wins; calculating a fresh 300 seconds after its INSERT would outlive that attempt.
            const expiresAt = Math.min(attempt.expiresAt, context.bindingExpiresAt ?? Infinity, now() + challenge.expiresInSeconds * 1000);
            return expiresAt > now() && await store.create({ ...attempt, expiresAt }) === 'created';
        },
        async callback(input: unknown, issuanceAvailable = true): Promise<string | null> {
            if (!isRecord(input) || !validState(input.state)) return null;
            const state = input.state;
            const binding = await store.readPending(stateHash(state));
            if (!binding) return null;
            if (binding.action !== 'delete' && !issuanceAvailable) throw new AppleAndroidHandoffError();
            const cancel = async () => { await store.cancelPending(binding); return returnUrl(state, 'cancelled'); };
            if (Object.keys(input).some(key => !['state', 'id_token', 'code', 'user', 'error'].includes(key))
                || Object.values(input).some(value => typeof value !== 'string')) return cancel();
            if ('error' in input) return cancel();
            if (typeof input.id_token !== 'string' || input.id_token.length > 16384 || input.id_token.length < 1
                || typeof input.code !== 'string' || input.code.length < 1 || input.code.length > 4096
                || /[^\x21-\x7e]/u.test(input.code)) return cancel();
            const verified = await verifier.verify('apple', input.id_token, binding.nonce);
            if (!verified.verified || verified.identity.provider !== 'apple') return cancel();
            const proof = await store.completeCallback(binding, { idToken: input.id_token, authorizationCode: input.code });
            return proof ? `${returnUrl(state, 'ready')}&proof=${proof}` : returnUrl(state, 'cancelled');
        },
        async redeem(context: ProviderAuthContext | null, input: unknown, issuanceAvailable = true) {
            if (!context || !isRecord(input) || Object.keys(input).sort().join(',') !== 'proof,state'
                || !validState(input.state) || !validState(input.proof)) return null;
            const binding = await store.readReady(stateHash(input.state), context.bindingHash);
            if (binding && binding.action !== 'delete' && !issuanceAvailable) throw new AppleAndroidHandoffError();
            return binding && contextMatches(context, binding) ? store.redeem(binding, input.proof) : null;
        },
    });
}
