// Public configuration only. This module never reads credentials or supplies legal policy defaults.
import { createHash } from 'node:crypto';

const fail = message => { throw new Error(`Provider release: ${message}`); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const providerConfigurationSha256 = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const PROVIDER_FIXED_ENV = Object.freeze({
    ACCOUNT_DELETION_ENABLED: 'true', ACCOUNT_DELETION_JOURNAL_BUCKET: 'ludolume-deletion-journal-1012884798546',
    ACCOUNT_IDENTITY_EPOCH: '2026-09-12 00:15:39.954172',
    GOOGLE_WEB_CLIENT_ID: '1012884798546-u18tb6962p05mdpfe6nov8uhe0pbeak8.apps.googleusercontent.com',
    GOOGLE_IOS_CLIENT_ID: '1012884798546-7ten55a60351ttr4ldeic64u3c45reeu.apps.googleusercontent.com',
    APPLE_IOS_BUNDLE_ID: 'com.mickeyf.app', APPLE_WEB_SERVICES_ID: 'com.mickeyf.web',
    APPLE_WEB_REDIRECT_URI: 'https://mickeyf.com/login', APPLE_TOKEN_RUNTIME_SECRETS_ENABLED: 'true',
    APPLE_TOKEN_LIFECYCLE_ENABLED: 'true', APPLE_NOTIFICATIONS_ENABLED: 'true',
    APPLE_MAINTENANCE_HTTP_ENABLED: 'true', APPLE_MAINTENANCE_CALLER_SUBJECT: '110493429670044173382',
    APPLE_MAINTENANCE_EXPECTED_SERVER_UUID: 'd1e6865c-ecad-11ee-a6b0-42010a400002',
    APPLE_SIGN_IN_TEAM_ID: 'AX4Z7T24C9', APPLE_SIGN_IN_KEY_ID: 'S5JDYNR7D5', APPLE_TOKEN_ACTIVE_KEY_ID: 'apple-token-v1',
    APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION: 'projects/1012884798546/secrets/ludolume-apple-signin-private-key/versions/1',
    APPLE_TOKEN_ENCRYPTION_KEYS_SECRET_VERSION: 'projects/1012884798546/secrets/ludolume-apple-token-encryption-keys/versions/1',
});
const flags = ['PROVIDER_AUTH_ENABLED', 'APPLE_WEB_AUTH_ENABLED', 'PROVIDER_GOOGLE_SIGNUP_ENABLED', 'PROVIDER_APPLE_SIGNUP_ENABLED',
    'PROVIDER_APPLE_DELETION_ENABLED', 'REGISTRATION_ENABLED', 'REGISTRATION_CREATION_ENABLED', 'REGISTRATION_POLICY_REVIEWED',
    'PARENT_REGISTRATION_ENABLED', 'PARENT_REGISTRATION_CREATION_ENABLED', 'PARENT_REGISTRATION_POLICY_REVIEWED',
    'PUBLIC_SCORE_PARTICIPATION_ENABLED', 'PUBLIC_SCORE_POLICY_REVIEWED', 'PUBLIC_SCORE_ASSURANCE_REVIEWED'];
const versions = ['REGISTRATION_POLICY_VERSION', 'PARENT_REGISTRATION_POLICY_VERSION', 'PARENT_CONSENT_VERSION',
    'PUBLIC_SCORE_POLICY_VERSION', 'PUBLIC_SCORE_CONSENT_VERSION'];
const noticeNames = ['PARENT_PRIVACY_NOTICE_URL', 'PUBLIC_SCORE_PRIVACY_NOTICE_URL'];
const texts = ['PARENT_CONSENT_TEXT', 'PUBLIC_SCORE_CONSENT_TEXT'];
const documents = ['REGISTRATION_COUNTRY_RULES', 'PARENT_REGISTRATION_COUNTRIES', 'PUBLIC_SCORE_COUNTRY_RULES'];
const policyKeys = [...versions, ...noticeNames, ...texts, ...documents];
export const PROVIDER_CREATION_FLAGS = Object.freeze(['REGISTRATION_CREATION_ENABLED', 'PROVIDER_GOOGLE_SIGNUP_ENABLED',
    'PROVIDER_APPLE_SIGNUP_ENABLED', 'PARENT_REGISTRATION_CREATION_ENABLED']);

function document(env, name) {
    try { return JSON.parse(env[name]); } catch { fail(`${name} must be valid JSON`); }
}
function keys(value, expected, label) {
    if (!record(value) || Object.keys(value).sort().join() !== [...expected].sort().join()) fail(`${label} has missing or unexpected fields`);
}

/** Preparation runs lifecycle/notifications with issuance closed. Activation requires the complete explicit policy bundle. */
export function providerReleaseEnvironment(config, rollback = false) {
    keys(config, ['phase', 'environment'], 'configuration');
    if (!['prepare', 'active'].includes(config.phase)) fail('phase must be prepare or active');
    const env = config.environment;
    keys(env, [...Object.keys(PROVIDER_FIXED_ENV), ...flags, ...(config.phase === 'active' ? policyKeys : [])], 'environment');
    for (const [name, value] of Object.entries(env)) {
        if (typeof value !== 'string' || value.length > 16_384 || value.includes('\0')) fail(`${name} must be bounded public text`);
    }
    for (const [name, value] of Object.entries(PROVIDER_FIXED_ENV)) if (env[name] !== value) fail(`fixed pin differs: ${name}`);
    for (const name of flags) if (!['true', 'false'].includes(env[name])) fail(`${name} must be an exact boolean`);
    if (config.phase === 'prepare') {
        for (const name of flags) if (env[name] !== 'false') fail(`preparation must keep ${name} closed`);
    } else {
        for (const name of flags) if (env[name] !== 'true') fail(`active release requires explicit ${name}`);
        for (const name of versions) if (!/^[A-Za-z0-9._-]{1,64}$/u.test(env[name])) fail(`${name} must be an explicit version`);
        for (const name of texts) if (!env[name].trim() || env[name].length > 8000) fail(`${name} is empty or too long`);
        for (const name of noticeNames) {
            let url;
            try { url = new URL(env[name]); } catch { fail(`${name} must be canonical HTTPS`); }
            if (url.protocol !== 'https:' || url.origin !== 'https://mickeyf.com' || url.username || url.password
                || url.search || url.hash || url.href !== env[name] || env[name].length > 2048
                || /[\s\u0000-\u001f\u007f\\]/u.test(env[name]) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(env[name])) {
                fail(`${name} must use a canonical mickeyf.com HTTPS notice URL`);
            }
        }
        const rules = document(env, 'REGISTRATION_COUNTRY_RULES');
        if (!record(rules) || !Object.keys(rules).length || Object.keys(rules).length > 249) fail('registration rules must be explicit');
        for (const [country, rule] of Object.entries(rules)) {
            if (!/^[A-Z]{2}$/u.test(country)) fail('invalid country code');
            keys(rule, ['parentRequiredBelow'], 'country rule');
            if (!Number.isInteger(rule.parentRequiredBelow) || rule.parentRequiredBelow < 1 || rule.parentRequiredBelow > 18) fail('invalid reviewed age boundary');
        }
        const parents = document(env, 'PARENT_REGISTRATION_COUNTRIES');
        if (!Array.isArray(parents) || !parents.length || parents.length > 249 || new Set(parents).size !== parents.length
            || parents.some(country => typeof country !== 'string' || !Object.hasOwn(rules, country))) fail('parent countries must be a reviewed registration subset');
        const publicRules = document(env, 'PUBLIC_SCORE_COUNTRY_RULES');
        if (!record(publicRules) || !Object.keys(publicRules).length) fail('public disclosure rules must be explicit');
        for (const [country, rule] of Object.entries(publicRules)) {
            keys(rule, ['parentManaged', 'selfAgeBands'], 'public rule');
            if (!Object.hasOwn(rules, country) || typeof rule.parentManaged !== 'boolean'
                || rule.parentManaged && !parents.includes(country) || !Array.isArray(rule.selfAgeBands)
                || new Set(rule.selfAgeBands).size !== rule.selfAgeBands.length
                || rule.selfAgeBands.some(band => !['minor', 'adult'].includes(band))) fail('invalid public disclosure country/authority rule');
        }
    }
    const result = { ...env };
    // Keep policy/proof, account management, private filtering, notifications and cleanup available.
    if (rollback) for (const name of PROVIDER_CREATION_FLAGS) result[name] = 'false';
    return result;
}
