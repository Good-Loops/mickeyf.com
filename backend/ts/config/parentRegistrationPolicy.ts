import type { ParentRegistrationPolicy } from '../accounts/parentRegistrationFlow';
import type { RegistrationPolicy } from './registrationPolicy';
import { parsePrivacyNoticeUrl } from './privacyNoticeUrl';

/** No country or legal assurance is inferred. Retain management policy when pausing new child creation. */
export function loadParentRegistrationPolicy(env: Readonly<Record<string, string | undefined>>, registration?: RegistrationPolicy): ParentRegistrationPolicy | undefined {
    if (env.PARENT_REGISTRATION_ENABLED !== 'true') return undefined;
    if (!registration || env.PARENT_REGISTRATION_POLICY_REVIEWED !== 'true'
        || env.PROVIDER_AUTH_ENABLED !== 'true' || env.ACCOUNT_DELETION_ENABLED !== 'true'
        || env.APPLE_MAINTENANCE_HTTP_ENABLED !== 'true') {
        throw new Error('Parent registration requires reviewed policy, providers, journaled deletion and authenticated maintenance.');
    }
    try {
        const version = env.PARENT_REGISTRATION_POLICY_VERSION ?? '';
        const consentVersion = env.PARENT_CONSENT_VERSION ?? '';
        const consentText = env.PARENT_CONSENT_TEXT ?? '';
        const privacyNoticeUrl = parsePrivacyNoticeUrl(env.PARENT_PRIVACY_NOTICE_URL);
        const countries: unknown = JSON.parse(env.PARENT_REGISTRATION_COUNTRIES ?? '');
        if (![version, consentVersion].every(value => /^[A-Za-z0-9._-]{1,64}$/u.test(value))
            || !privacyNoticeUrl || !consentText.trim() || consentText.length > 8000 || !Array.isArray(countries) || !countries.length || countries.length > 249
            || countries.some(country => typeof country !== 'string' || !Object.prototype.hasOwnProperty.call(registration.countries, country))
            || new Set(countries).size !== countries.length) throw new Error();
        return Object.freeze({ version, consentVersion, consentText, privacyNoticeUrl, countries: Object.freeze([...countries].sort()),
            creationEnabled: env.PARENT_REGISTRATION_CREATION_ENABLED === 'true',
            ...(env.PARENT_SIGNED_FORMS_ENABLED === 'true' ? { signedFormsEnabled: true } : {}) });
    } catch { throw new Error('Parent registration requires explicit reviewed countries, policy, consent versions/text and an HTTPS privacy notice URL.'); }
}
