import { createHash } from 'node:crypto';
import { isRecord } from '../security/userRequestValidation';

export type RegistrationAgeBand = 'parent-required' | 'minor' | 'adult';
export type RegistrationPolicy = Readonly<{
    version: string;
    digest: Buffer;
    countries: Readonly<Record<string, Readonly<{ parentRequiredBelow: number }>>>;
    mode?: 'general-audience';
}>;
export type RegistrationDecision = Readonly<{ allowed: true; country: string | null; ageBand: 'minor' | 'adult' | null }>
    | Readonly<{ allowed: false; reason: 'REGISTRATION_CLOSED' | 'INVALID_REGISTRATION' | 'PARENT_REQUIRED' }>;

/** Country rules are reviewed product configuration, never inferred from IP or a provider profile. */
export function loadRegistrationPolicy(env: Readonly<Record<string, string | undefined>> = process.env): RegistrationPolicy | undefined {
    if (env.REGISTRATION_ENABLED !== 'true') return undefined;
    if (env.REGISTRATION_POLICY_REVIEWED !== 'true') throw new Error('Registration requires a reviewed country policy.');
    try {
        const enabled = env.REGISTRATION_GENERAL_AUDIENCE_ENABLED;
        if (enabled !== undefined && enabled !== 'false' && enabled !== 'true') throw new Error();
        const generalAudience = enabled === 'true';
        const originalVersion = env.REGISTRATION_POLICY_VERSION ?? '';
        const version = generalAudience ? env.REGISTRATION_GENERAL_AUDIENCE_POLICY_VERSION ?? '' : originalVersion;
        if (generalAudience && (env.REGISTRATION_GENERAL_AUDIENCE_POLICY_REVIEWED !== 'true'
            || version === originalVersion)) throw new Error();
        if (!/^[A-Za-z0-9._-]{1,64}$/u.test(version)) throw new Error();
        const raw: unknown = JSON.parse(env.REGISTRATION_COUNTRY_RULES ?? '');
        if (!isRecord(raw) || Object.keys(raw).length < 1 || Object.keys(raw).length > 249) throw new Error();
        const countries: Record<string, Readonly<{ parentRequiredBelow: number }>> = Object.create(null);
        for (const country of Object.keys(raw).sort()) {
            const rule = raw[country];
            if (!/^[A-Z]{2}$/u.test(country) || !isRecord(rule)
                || Object.keys(rule).join(',') !== 'parentRequiredBelow'
                || !Number.isSafeInteger(rule.parentRequiredBelow)
                || Number(rule.parentRequiredBelow) < 1 || Number(rule.parentRequiredBelow) > 18) throw new Error();
            countries[country] = Object.freeze({ parentRequiredBelow: Number(rule.parentRequiredBelow) });
        }
        // A rule change invalidates outstanding approvals even if the operator forgets to change the version.
        const digest = createHash('sha256').update(JSON.stringify(generalAudience
            ? [version, countries, 'general-audience'] : [version, countries])).digest();
        return Object.freeze({ version, digest, countries: Object.freeze(countries),
            ...(generalAudience ? { mode: 'general-audience' as const } : {}) });
    } catch { throw new Error('Registration policy requires an explicit version and valid country rules.'); }
}

/** Pause new self-service accounts without discarding policy needed by existing family management. */
export function registrationPolicyForCreation(policy: RegistrationPolicy | undefined,
    env: Readonly<Record<string, string | undefined>> = process.env): RegistrationPolicy | undefined {
    const enabled = env.REGISTRATION_CREATION_ENABLED;
    if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') {
        throw new Error('REGISTRATION_CREATION_ENABLED must be true or false when supplied.');
    }
    return enabled === 'false' ? undefined : policy;
}

export function decideRegistration(policy: RegistrationPolicy | undefined, input: unknown): RegistrationDecision {
    if (!policy) return { allowed: false, reason: 'REGISTRATION_CLOSED' };
    if (policy.mode === 'general-audience') {
        if (!isRecord(input) || Object.keys(input).join(',') !== 'policyVersion'
            || input.policyVersion !== policy.version) {
            return { allowed: false, reason: 'INVALID_REGISTRATION' };
        }
        return { allowed: true, country: null, ageBand: null };
    }
    if (!isRecord(input) || Object.keys(input).sort().join(',') !== 'ageBand,country,policyVersion'
        || input.policyVersion !== policy.version || typeof input.country !== 'string'
        || !Object.prototype.hasOwnProperty.call(policy.countries, input.country)
        || typeof input.ageBand !== 'string' || !['parent-required', 'minor', 'adult'].includes(input.ageBand)) {
        return { allowed: false, reason: 'INVALID_REGISTRATION' };
    }
    // No self-attested checkbox is a verified parent. This branch stays closed until that workflow is reviewed.
    if (input.ageBand === 'parent-required') return { allowed: false, reason: 'PARENT_REQUIRED' };
    if (input.ageBand === 'minor' && policy.countries[input.country].parentRequiredBelow === 18) {
        return { allowed: false, reason: 'INVALID_REGISTRATION' };
    }
    return { allowed: true, country: input.country, ageBand: input.ageBand as 'minor' | 'adult' };
}
