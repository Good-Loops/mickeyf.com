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
// Play-delivered packages use the app-signing certificate, not the upload key.
export const PROVIDER_ANDROID_PRESENTER_PINS = Object.freeze([Object.freeze({
    packageName: 'com.mickeyf.app', signer: 'play-app-signing',
    certificateSha1: 'D7F8253276437C861ED1332EC25D29412C2B5FAB',
    certificateSha256: 'A0129DF3CF1C6B64F60C97C6254DCE67B5DD141C64126084AD2316B1177C7135',
    clientId: '1012884798546-np0a4m1eq3nm948m5o8ocpck3qcflpk4.apps.googleusercontent.com',
})]);
const androidEnvironmentKeys = ['GOOGLE_ANDROID_CLIENT_ID', 'GOOGLE_ANDROID_CLIENT_IDS'];
const googleClientId = value => typeof value === 'string' && value.length <= 255 && value === value.trim()
    && /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/u.test(value);
const flags = ['PROVIDER_AUTH_ENABLED', 'APPLE_WEB_AUTH_ENABLED', 'PROVIDER_GOOGLE_SIGNUP_ENABLED', 'PROVIDER_APPLE_SIGNUP_ENABLED',
    'PROVIDER_APPLE_DELETION_ENABLED', 'REGISTRATION_ENABLED', 'REGISTRATION_CREATION_ENABLED', 'REGISTRATION_POLICY_REVIEWED',
    'PARENT_REGISTRATION_ENABLED', 'PARENT_REGISTRATION_CREATION_ENABLED', 'PARENT_REGISTRATION_POLICY_REVIEWED', 'PARENT_SIGNED_FORMS_ENABLED',
    'PUBLIC_SCORE_PARTICIPATION_ENABLED', 'PUBLIC_SCORE_POLICY_REVIEWED', 'PUBLIC_SCORE_ASSURANCE_REVIEWED'];
const versions = ['REGISTRATION_POLICY_VERSION', 'PARENT_REGISTRATION_POLICY_VERSION', 'PARENT_CONSENT_VERSION',
    'PUBLIC_SCORE_POLICY_VERSION', 'PUBLIC_SCORE_CONSENT_VERSION'];
const noticeNames = ['PARENT_PRIVACY_NOTICE_URL', 'PUBLIC_SCORE_PRIVACY_NOTICE_URL'];
const texts = ['PARENT_CONSENT_TEXT', 'PUBLIC_SCORE_CONSENT_TEXT'];
const documents = ['REGISTRATION_COUNTRY_RULES', 'PARENT_REGISTRATION_COUNTRIES', 'PUBLIC_SCORE_COUNTRY_RULES'];
const policyKeys = [...versions, ...noticeNames, ...texts, ...documents];
const generalPolicyKeys = ['REGISTRATION_GENERAL_AUDIENCE_ENABLED', 'REGISTRATION_GENERAL_AUDIENCE_POLICY_REVIEWED',
    'REGISTRATION_GENERAL_AUDIENCE_POLICY_VERSION'];
const childPolicyKeys = ['REGISTRATION_AUDIENCE', 'PARENT_SIGNED_FORM_COUNTRIES'];
const childMaintenanceKeys = ['CHILD_ONLINE_ACTIVITY_ENABLED', 'CHILD_INACTIVITY_ENABLED', 'CHILD_DAILY_USAGE_ENABLED',
    'CHILD_DAILY_USAGE_RECEIPT_RETENTION_ENABLED', 'PARENT_FORM_RELAY_STATE_ENABLED'];
const runtimeGrantProfiles = ['google-apple-parent-signed', 'google-apple-parent-signed-recovery',
    'google-apple-parent-signed-recovery-usage'];
export const PROVIDER_CREATION_FLAGS = Object.freeze(['REGISTRATION_CREATION_ENABLED', 'PROVIDER_GOOGLE_SIGNUP_ENABLED',
    'PROVIDER_APPLE_SIGNUP_ENABLED', 'PARENT_REGISTRATION_CREATION_ENABLED']);

/** The legacy default does not authorize newly added grants or runtime settings. */
export function providerRuntimeGrantProfile(config) {
    const profile = record(config) && Object.hasOwn(config, 'runtimeGrantProfile')
        ? config.runtimeGrantProfile : 'google-apple-parent-signed';
    if (!runtimeGrantProfiles.includes(profile)) fail('runtime grant profile must be an exact reviewed profile');
    return profile;
}

function document(env, name) {
    try { return JSON.parse(env[name]); } catch { fail(`${name} must be valid JSON`); }
}
function keys(value, expected, label) {
    if (!record(value) || Object.keys(value).sort().join() !== [...expected].sort().join()) fail(`${label} has missing or unexpected fields`);
}

/** Pure public-metadata validation; release entry points always supply the source-owned reviewed table. */
export function validateAndroidPresenterPins(env, reviewedPins) {
    if (!Array.isArray(reviewedPins) || reviewedPins.length > 8) fail('invalid reviewed Android presenter table');
    const clients = new Set(), sha1s = new Set(), sha256s = new Set();
    for (const pin of reviewedPins) {
        keys(pin, ['packageName', 'signer', 'certificateSha1', 'certificateSha256', 'clientId'], 'Android presenter pin');
        if (pin.packageName !== 'com.mickeyf.app' || pin.signer !== 'play-app-signing'
            || typeof pin.certificateSha1 !== 'string' || pin.certificateSha1.length !== 40 || !/^[A-F0-9]{40}$/u.test(pin.certificateSha1)
            || typeof pin.certificateSha256 !== 'string' || pin.certificateSha256.length !== 64 || !/^[A-F0-9]{64}$/u.test(pin.certificateSha256)
            || !googleClientId(pin.clientId) || !pin.clientId.startsWith('1012884798546-')
            || [env.GOOGLE_WEB_CLIENT_ID, env.GOOGLE_IOS_CLIENT_ID].includes(pin.clientId)
            || clients.has(pin.clientId) || sha1s.has(pin.certificateSha1) || sha256s.has(pin.certificateSha256)) {
            fail('Android presenter pins require distinct exact Play certificate/OAuth mappings');
        }
        clients.add(pin.clientId); sha1s.add(pin.certificateSha1); sha256s.add(pin.certificateSha256);
    }
    const names = androidEnvironmentKeys.filter(name => Object.hasOwn(env, name));
    if (!names.length) return [];
    if (names.length !== 1) fail('Android client ID options are mutually exclusive');
    if (typeof env[names[0]] !== 'string' || env[names[0]].length > 4096) fail('Android client IDs must be bounded public text');
    const ids = names[0] === 'GOOGLE_ANDROID_CLIENT_ID' ? [env[names[0]]] : document(env, names[0]);
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 8 || new Set(ids).size !== ids.length
        || ids.some(id => !googleClientId(id) || !clients.has(id))) {
        fail('Android requires 1–8 distinct OAuth clients with reviewed Play certificate mappings');
    }
    return [...ids];
}

/** Child preparation preserves reviewed login/management while every new-account path is closed. */
export function providerReleaseEnvironment(config, rollback = false) {
    const runtimeProfile = providerRuntimeGrantProfile(config);
    const childMaintenance = runtimeProfile !== 'google-apple-parent-signed';
    keys(config, ['phase', 'environment', ...(record(config) && Object.hasOwn(config, 'runtimeGrantProfile') ? ['runtimeGrantProfile'] : []),
        ...(childMaintenance ? ['noticeVersions'] : [])], 'configuration');
    if (!['prepare', 'prepare-child', 'prepare-adult', 'paused-general', 'active', 'active-adult'].includes(config.phase)) fail('invalid release phase');
    const env = config.environment;
    const adultFirst = ['prepare-adult', 'active-adult'].includes(config.phase);
    const generalAudience = record(env) && generalPolicyKeys.some(name => Object.hasOwn(env, name));
    const childAudience = record(env) && childPolicyKeys.some(name => Object.hasOwn(env, name));
    keys(env, [...Object.keys(PROVIDER_FIXED_ENV), ...flags, ...(config.phase !== 'prepare' ? policyKeys : []),
        ...(generalAudience ? generalPolicyKeys : []), ...(childAudience ? childPolicyKeys : []), ...(adultFirst ? ['REGISTRATION_ADULT_ONLY'] : []),
        ...(childMaintenance ? childMaintenanceKeys : []),
        ...androidEnvironmentKeys.filter(name => record(env) && Object.hasOwn(env, name))], 'environment');
    if (childMaintenance) {
        if (!childAudience || config.phase === 'prepare') fail('recovery maintenance requires the explicit child-audience policy');
        keys(config.noticeVersions, ['privacy', 'signedParentForm'], 'notice versions');
        const suffix = /^privacy-(\d{4}-\d{2}-\d{2}\.\d+)$/u.exec(config.noticeVersions.privacy)?.[1];
        if (!suffix || config.noticeVersions.signedParentForm !== `signed-parent-form-${suffix}`) fail('notice and signed form must have matching explicit versions');
        // This release path prepares maintenance only. Activity, mail and daily collection
        // require their separately qualified deployment, including secret references.
        for (const name of ['CHILD_ONLINE_ACTIVITY_ENABLED', 'CHILD_INACTIVITY_ENABLED', 'CHILD_DAILY_USAGE_ENABLED']) {
            if (env[name] !== 'false') fail(`${name} must remain closed during maintenance preparation`);
        }
        if (!['true', 'false'].includes(env.CHILD_DAILY_USAGE_RECEIPT_RETENTION_ENABLED)
            || env.CHILD_DAILY_USAGE_RECEIPT_RETENTION_ENABLED === 'true' && runtimeProfile !== 'google-apple-parent-signed-recovery-usage') {
            fail('receipt retention requires the exact usage grant profile');
        }
        if (!['0', '1'].includes(env.PARENT_FORM_RELAY_STATE_ENABLED)) fail('parent relay state must be 0 or 1');
    }
    if (childAudience && (config.phase === 'prepare' || generalAudience || env.REGISTRATION_AUDIENCE !== 'children-included')) {
        fail('children-included registration requires its reviewed staged policy, without general signup');
    }
    if (['prepare-child', 'prepare-adult', 'active-adult'].includes(config.phase) && !childAudience) fail('child or adult preparation requires the explicit children-included policy');
    if (adultFirst && env.REGISTRATION_ADULT_ONLY !== 'true') fail('adult-first release requires adult-only enforcement');
    if (config.phase === 'paused-general' && (!generalAudience || childAudience)) fail('paused-general requires a general-audience policy');
    for (const [name, value] of Object.entries(env)) {
        if (typeof value !== 'string' || value.length > 16_384 || value.includes('\0')) fail(`${name} must be bounded public text`);
    }
    for (const [name, value] of Object.entries(PROVIDER_FIXED_ENV)) if (env[name] !== value) fail(`fixed pin differs: ${name}`);
    validateAndroidPresenterPins(env, PROVIDER_ANDROID_PRESENTER_PINS);
    for (const name of flags) if (!['true', 'false'].includes(env[name])) fail(`${name} must be an exact boolean`);
    if (config.phase === 'prepare') {
        if (generalAudience) fail('general signup requires an explicit active policy bundle');
        for (const name of flags) if (env[name] !== 'false') fail(`preparation must keep ${name} closed`);
    } else {
        for (const name of flags) {
            const publicClosed = childAudience && env.PUBLIC_SCORE_PARTICIPATION_ENABLED === 'false'
                && ['PUBLIC_SCORE_PARTICIPATION_ENABLED', 'PUBLIC_SCORE_POLICY_REVIEWED', 'PUBLIC_SCORE_ASSURANCE_REVIEWED'].includes(name);
            const creationClosed = ['prepare-child', 'prepare-adult', 'paused-general'].includes(config.phase) && PROVIDER_CREATION_FLAGS.includes(name);
            const expected = (generalAudience || adultFirst) && name === 'PARENT_REGISTRATION_CREATION_ENABLED' || publicClosed || creationClosed ? 'false' : 'true';
            if (env[name] !== expected) fail(`${config.phase} release requires explicit ${name}=${expected}`);
        }
        if (generalAudience && (env.REGISTRATION_GENERAL_AUDIENCE_ENABLED !== 'true'
            || env.REGISTRATION_GENERAL_AUDIENCE_POLICY_REVIEWED !== 'true'
            || !/^[A-Za-z0-9._-]{1,64}$/u.test(env.REGISTRATION_GENERAL_AUDIENCE_POLICY_VERSION)
            || env.REGISTRATION_GENERAL_AUDIENCE_POLICY_VERSION === env.REGISTRATION_POLICY_VERSION)) {
            fail('general signup requires its own reviewed version');
        }
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
        if (childAudience) {
            const signedCountries = document(env, 'PARENT_SIGNED_FORM_COUNTRIES');
            if (!Array.isArray(signedCountries) || signedCountries.length !== parents.length
                || new Set(signedCountries).size !== signedCountries.length
                || signedCountries.some(country => !['BR', 'US'].includes(country) || !parents.includes(country))
                || !adultFirst && Object.keys(rules).some(country => !parents.includes(country))) {
                fail('every child country requires an explicit supported signed-parent-form policy');
            }
        }
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
