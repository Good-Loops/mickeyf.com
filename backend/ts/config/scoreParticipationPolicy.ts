import { createHash } from 'node:crypto';
import { isRecord } from '../security/userRequestValidation';
import { parsePrivacyNoticeUrl } from './privacyNoticeUrl';
import type { RegistrationPolicy } from './registrationPolicy';

export type ScoreParticipationPolicy = Readonly<{
    version: string; consentVersion: string; consentText: string; privacyNoticeUrl: string;
    registrationVersion: string; parentRegistrationVersion?: string; digest: Buffer;
    countries: Readonly<Record<string, Readonly<{ selfAgeBands: readonly ('minor' | 'adult')[]; parentManaged: boolean }>>>;
}>;

/** Publication is a separate reviewed disclosure decision; a provider login is not asserted to be VPC. */
export function loadScoreParticipationPolicy(env: Readonly<Record<string, string | undefined>>,
    registration?: RegistrationPolicy): ScoreParticipationPolicy | undefined {
    if (env.PUBLIC_SCORE_PARTICIPATION_ENABLED !== 'true') return undefined;
    if (!registration || env.PUBLIC_SCORE_POLICY_REVIEWED !== 'true' || env.PUBLIC_SCORE_ASSURANCE_REVIEWED !== 'true'
        || env.PROVIDER_AUTH_ENABLED !== 'true' || env.ACCOUNT_DELETION_ENABLED !== 'true') {
        throw new Error('Public participation requires separately reviewed regional disclosure and assurance policies.');
    }
    try {
        const version = env.PUBLIC_SCORE_POLICY_VERSION ?? '';
        const consentVersion = env.PUBLIC_SCORE_CONSENT_VERSION ?? '';
        const consentText = env.PUBLIC_SCORE_CONSENT_TEXT ?? '';
        const privacyNoticeUrl = parsePrivacyNoticeUrl(env.PUBLIC_SCORE_PRIVACY_NOTICE_URL);
        const raw: unknown = JSON.parse(env.PUBLIC_SCORE_COUNTRY_RULES ?? '');
        if (![version, consentVersion].every(value => /^[A-Za-z0-9._-]{1,64}$/u.test(value)) || !privacyNoticeUrl
            || !consentText.trim() || consentText.length > 8000 || !isRecord(raw) || !Object.keys(raw).length) throw new Error();
        const countries: Record<string, ScoreParticipationPolicy['countries'][string]> = Object.create(null);
        for (const country of Object.keys(raw).sort()) {
            const rule = raw[country];
            if (!Object.prototype.hasOwnProperty.call(registration.countries, country) || !isRecord(rule)
                || Object.keys(rule).sort().join(',') !== 'parentManaged,selfAgeBands' || typeof rule.parentManaged !== 'boolean'
                || !Array.isArray(rule.selfAgeBands) || rule.selfAgeBands.length > 2
                || rule.selfAgeBands.some(band => band !== 'minor' && band !== 'adult')
                || new Set(rule.selfAgeBands).size !== rule.selfAgeBands.length) throw new Error();
            countries[country] = Object.freeze({ parentManaged: rule.parentManaged,
                selfAgeBands: Object.freeze([...rule.selfAgeBands].sort()) });
        }
        const parentRegistrationVersion = env.PARENT_REGISTRATION_POLICY_VERSION;
        if (Object.values(countries).some(rule => rule.parentManaged)
            && (env.PARENT_REGISTRATION_ENABLED !== 'true' || env.PARENT_REGISTRATION_POLICY_REVIEWED !== 'true'
                || !/^[A-Za-z0-9._-]{1,64}$/u.test(parentRegistrationVersion ?? ''))) throw new Error();
        const digest = createHash('sha256').update(JSON.stringify([version, consentVersion, consentText, privacyNoticeUrl,
            registration.version, registration.digest.toString('hex'), parentRegistrationVersion ?? null, countries])).digest();
        return Object.freeze({ version, consentVersion, consentText, privacyNoticeUrl, registrationVersion: registration.version,
            countries: Object.freeze(countries), parentRegistrationVersion, digest });
    } catch { throw new Error('Public participation requires explicit valid policy, consent, notice and country rules.'); }
}

export function mayPublishScores(policy: ScoreParticipationPolicy | undefined,
    profile: { country: string; ageBand: string; registrationVersion: string } | null, authority: 'self' | 'parent'): boolean {
    if (!policy || !profile || profile.registrationVersion !== (authority === 'parent' ? policy.parentRegistrationVersion : policy.registrationVersion)) return false;
    const rule = policy.countries[profile.country];
    return !!rule && (authority === 'parent' ? rule.parentManaged
        : rule.selfAgeBands.some(band => band === profile.ageBand));
}
