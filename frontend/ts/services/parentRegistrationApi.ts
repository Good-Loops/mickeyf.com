import type { ProviderAuthenticationChallenge } from './authApi.ts';
import { parsePrivacyNoticeUrl } from '../config/privacyNoticeUrl.ts';

export type ParentConfig = Readonly<{ enabled: false }> | Readonly<{ enabled: true; policyVersion: string;
    consentVersion: string; consentText: string; privacyNoticeUrl: string; countries: readonly string[]; creationEnabled: boolean }>;
export type ScoreParticipationConfig = Readonly<{ enabled: false }> | Readonly<{ enabled: true; policyVersion: string;
    consentVersion: string; consentText: string; privacyNoticeUrl: string }>;
export type ParentConsent = Readonly<{ country: string; adultAttestation: true; guardianAttestation: true; consent: true }>;
export type ParentApproval = Readonly<{ grant: string; purpose: 'create-child' | 'withdraw-child' | 'delete-family' | 'publish-scores'; expiresInSeconds: number }>;
export class ParentRegistrationError extends Error {
    readonly code: string;
    constructor(code: string) { super('The parent operation could not be confirmed.'); this.code = code; }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string) => Object.keys(value).sort().join(',') === expected;
const token = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value);
const version = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(value);
const expiry = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 300;

/** Grant/state stay in component memory. No child email, exact DOB, browser storage or session replacement. */
export function createParentRegistrationApi(apiBase: string, fetchRequest: typeof fetch) {
    async function request(path: string, body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const timeout = setTimeout(abort, 10_000);
        try {
            const response = await fetchRequest(`${apiBase}/auth/parent-registration${path}`, {
                method: body === undefined ? 'GET' : 'POST', credentials: 'include', signal: controller.signal,
                ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
            });
            const value: unknown = await response.json();
            if (!record(value)) throw new ParentRegistrationError('UNAVAILABLE');
            if (response.status !== 200) {
                const statuses: Record<string, number> = { CLOSED: 503, UNAVAILABLE: 503, INVALID_REQUEST: 400,
                    INVALID_CONTEXT: 403, INVALID_ATTEMPT: 403, INVALID_PROVIDER_TOKEN: 401,
                    PROVIDER_NOT_LINKED: 403, VERIFIED_CONTACT_REQUIRED: 403, RATE_LIMITED: 429 };
                throw new ParentRegistrationError(keys(value, 'error') && typeof value.error === 'string'
                    && Object.prototype.hasOwnProperty.call(statuses, value.error) && statuses[value.error] === response.status ? value.error : 'UNAVAILABLE');
            }
            return value;
        } catch (error) {
            if (error instanceof ParentRegistrationError) throw error;
            throw new ParentRegistrationError(signal?.aborted ? 'CANCELLED' : 'UNAVAILABLE');
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
        }
    }
    return {
        async config(signal?: AbortSignal): Promise<ParentConfig> {
            const value = await request('/config', undefined, signal);
            if (keys(value, 'enabled') && value.enabled === false) return { enabled: false };
            if (!keys(value, 'consentText,consentVersion,countries,creationEnabled,enabled,policyVersion,privacyNoticeUrl') || value.enabled !== true || typeof value.creationEnabled !== 'boolean'
                || !version(value.policyVersion) || !version(value.consentVersion) || typeof value.consentText !== 'string'
                || !parsePrivacyNoticeUrl(value.privacyNoticeUrl) || !value.consentText.trim() || value.consentText.length > 8000 || !Array.isArray(value.countries)
                || value.countries.length < 1 || value.countries.length > 249
                || value.countries.some(country => typeof country !== 'string' || !/^[A-Z]{2}$/u.test(country))
                || new Set(value.countries).size !== value.countries.length) throw new ParentRegistrationError('UNAVAILABLE');
            return value as ParentConfig;
        },
        async begin(config: Extract<ParentConfig, { enabled: true }>, clientKey: string, consent: ParentConsent,
            signal?: AbortSignal): Promise<ProviderAuthenticationChallenge> {
            const value = await request('/begin', { purpose: 'create-child', policyVersion: config.policyVersion,
                consentVersion: config.consentVersion, privacyNoticeUrl: config.privacyNoticeUrl, clientKey, country: consent.country,
                adultAttestation: consent.adultAttestation, guardianAttestation: consent.guardianAttestation, consent: consent.consent }, signal);
            if (!keys(value, 'expiresInSeconds,nonce,state') || !token(value.state) || !token(value.nonce)
                || !expiry(value.expiresInSeconds)) throw new ParentRegistrationError('UNAVAILABLE');
            return value as ProviderAuthenticationChallenge;
        },
        async complete(state: string, idToken: string, signal?: AbortSignal): Promise<ParentApproval> {
            const value = await request('/complete', { state, idToken }, signal);
            if (!keys(value, 'expiresInSeconds,grant,purpose') || !token(value.grant) || !expiry(value.expiresInSeconds)
                || !['create-child', 'withdraw-child', 'delete-family', 'publish-scores'].includes(String(value.purpose))) throw new ParentRegistrationError('UNAVAILABLE');
            return value as ParentApproval;
        },
        async cancel(state: string): Promise<void> {
            const value = await request('/cancel', { state });
            if (!keys(value, 'cancelled') || value.cancelled !== true) throw new ParentRegistrationError('UNAVAILABLE');
        },
        async createChild(grant: string, userName: string, password: string, signal?: AbortSignal) {
            const value = await request('/children', { grant, userName, password }, signal);
            if (!keys(value, 'child,created') || value.created !== true || !record(value.child)
                || !keys(value.child, 'accountId,scoreVisibility,userName') || value.child.scoreVisibility !== 'private'
                || typeof value.child.userName !== 'string' || !value.child.userName || value.child.userName.length > 64
                || typeof value.child.accountId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.child.accountId)) {
                throw new ParentRegistrationError('UNAVAILABLE');
            }
            return { accountId: value.child.accountId, userName: value.child.userName, scoreVisibility: 'private' as const };
        },
        async listChildren(signal?: AbortSignal) {
            const value = await request('/children/list', {}, signal);
            if (!keys(value, 'children') || !Array.isArray(value.children) || value.children.length > 50) throw new ParentRegistrationError('UNAVAILABLE');
            return value.children.map(child => {
                if (!record(child) || !keys(child, 'accountId,scoreVisibility,userName') || child.scoreVisibility !== 'private'
                    || typeof child.accountId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(child.accountId)
                    || typeof child.userName !== 'string' || !child.userName || child.userName.length > 64) throw new ParentRegistrationError('UNAVAILABLE');
                return { accountId: child.accountId, userName: child.userName };
            });
        },
        async beginWithdrawal(config: Extract<ParentConfig, { enabled: true }>, clientKey: string, childAccountId: string, signal?: AbortSignal): Promise<ProviderAuthenticationChallenge> {
            const value = await request('/begin', { purpose: 'withdraw-child', policyVersion: config.policyVersion,
                clientKey, childAccountId, confirmation: 'WITHDRAW AND DELETE' }, signal);
            if (!keys(value, 'expiresInSeconds,nonce,state') || !token(value.state) || !token(value.nonce) || !expiry(value.expiresInSeconds)) throw new ParentRegistrationError('UNAVAILABLE');
            return value as ProviderAuthenticationChallenge;
        },
        async scoreConfig(signal?: AbortSignal): Promise<ScoreParticipationConfig> {
            const value = await request('/scores/config', undefined, signal);
            if (keys(value, 'enabled') && value.enabled === false) return { enabled: false };
            if (!keys(value, 'consentText,consentVersion,enabled,policyVersion,privacyNoticeUrl') || value.enabled !== true
                || !version(value.policyVersion) || !version(value.consentVersion) || !parsePrivacyNoticeUrl(value.privacyNoticeUrl)
                || typeof value.consentText !== 'string' || !value.consentText.trim() || value.consentText.length > 8000) throw new ParentRegistrationError('UNAVAILABLE');
            return value as ScoreParticipationConfig;
        },
        async scoreStatus(childAccountId: string | null, signal?: AbortSignal) {
            const value = await request('/scores/status', { childAccountId }, signal);
            if (!keys(value, 'canPublish,visibility') || !['private', 'public'].includes(String(value.visibility))
                || typeof value.canPublish !== 'boolean') throw new ParentRegistrationError('UNAVAILABLE');
            return { visibility: value.visibility as 'private' | 'public', canPublish: value.canPublish };
        },
        async beginScorePublication(config: Extract<ScoreParticipationConfig, { enabled: true }>, clientKey: string,
            childAccountId: string | null, signal?: AbortSignal): Promise<ProviderAuthenticationChallenge> {
            const value = await request('/begin', { purpose: 'publish-scores', childAccountId, clientKey,
                policyVersion: config.policyVersion, consentVersion: config.consentVersion, consentText: config.consentText,
                privacyNoticeUrl: config.privacyNoticeUrl, participation: true }, signal);
            if (!keys(value, 'expiresInSeconds,nonce,state') || !token(value.state) || !token(value.nonce) || !expiry(value.expiresInSeconds)) throw new ParentRegistrationError('UNAVAILABLE');
            return value as ProviderAuthenticationChallenge;
        },
        async publishScores(grant: string, signal?: AbortSignal): Promise<void> {
            const value = await request('/scores/publish', { grant }, signal);
            if (!keys(value, 'visibility') || value.visibility !== 'public') throw new ParentRegistrationError('UNAVAILABLE');
        },
        async withdrawScores(childAccountId: string | null, signal?: AbortSignal): Promise<void> {
            const value = await request('/scores/withdraw', { childAccountId }, signal);
            if (!keys(value, 'visibility') || value.visibility !== 'private') throw new ParentRegistrationError('UNAVAILABLE');
        },
        async beginFamilyDeletion(config: Extract<ParentConfig, { enabled: true }>, clientKey: string, childAccountIds: readonly string[], signal?: AbortSignal): Promise<ProviderAuthenticationChallenge> {
            const value = await request('/begin', { purpose: 'delete-family', policyVersion: config.policyVersion,
                clientKey, childAccountIds, confirmation: 'DELETE MY FAMILY' }, signal);
            if (!keys(value, 'expiresInSeconds,nonce,state') || !token(value.state) || !token(value.nonce) || !expiry(value.expiresInSeconds)) throw new ParentRegistrationError('UNAVAILABLE');
            return value as ProviderAuthenticationChallenge;
        },
        async withdraw(grant: string, signal?: AbortSignal): Promise<void> {
            const value = await request('/withdraw', { grant, confirmation: 'WITHDRAW AND DELETE' }, signal);
            if (!keys(value, 'deleted') || value.deleted !== true) throw new ParentRegistrationError('UNAVAILABLE');
        },
    };
}
export type ParentRegistrationApi = ReturnType<typeof createParentRegistrationApi>;
