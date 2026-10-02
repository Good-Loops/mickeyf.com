import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRegistrationPolicy } from './registrationPolicy';
import { loadParentRegistrationPolicy } from './parentRegistrationPolicy';
const base = { REGISTRATION_ENABLED: 'true', REGISTRATION_POLICY_REVIEWED: 'true', REGISTRATION_POLICY_VERSION: 'test',
    REGISTRATION_COUNTRY_RULES: '{"ZZ":{"parentRequiredBelow":16}}' };
const env = { ...base, PARENT_REGISTRATION_ENABLED: 'true', PARENT_REGISTRATION_POLICY_REVIEWED: 'true',
    PARENT_REGISTRATION_POLICY_VERSION: 'parent-test', PARENT_CONSENT_VERSION: 'consent-test', PARENT_CONSENT_TEXT: 'Synthetic consent only.',
    PARENT_PRIVACY_NOTICE_URL: 'https://notice.example.test/privacy', PARENT_REGISTRATION_COUNTRIES: '["ZZ"]', PROVIDER_AUTH_ENABLED: 'true', ACCOUNT_DELETION_ENABLED: 'true', APPLE_MAINTENANCE_HTTP_ENABLED: 'true' };
test('parent capability is absent by default; new creation separately defaults closed', () => {
    assert.equal(loadParentRegistrationPolicy({}, loadRegistrationPolicy(base)), undefined);
    assert.equal(loadParentRegistrationPolicy(env, loadRegistrationPolicy(base))?.creationEnabled, false);
    assert.equal(loadParentRegistrationPolicy({ ...env, PARENT_REGISTRATION_CREATION_ENABLED: 'true' }, loadRegistrationPolicy(base))?.creationEnabled, true);
});
test('no invented country, consent text or unreviewed assurance can enable the parent route', () => {
    for (const patch of [{ PARENT_REGISTRATION_COUNTRIES: '["US"]' }, { PARENT_REGISTRATION_COUNTRIES: '["ZZ","ZZ"]' },
        { PARENT_CONSENT_TEXT: '' }, { PARENT_CONSENT_VERSION: '' }, { PARENT_REGISTRATION_POLICY_REVIEWED: 'false' },
        { PROVIDER_AUTH_ENABLED: 'false' }, { ACCOUNT_DELETION_ENABLED: 'false' }, { APPLE_MAINTENANCE_HTTP_ENABLED: 'false' }]) {
        assert.throws(() => loadParentRegistrationPolicy({ ...env, ...patch }, loadRegistrationPolicy(base)));
    }
    assert.throws(() => loadParentRegistrationPolicy(env));
});

test('enabled parent policy requires a usable HTTPS notice; closed defaults do not acquire new prerequisites', () => {
    assert.equal(loadParentRegistrationPolicy({ PARENT_PRIVACY_NOTICE_URL: 'javascript:alert(1)' }), undefined);
    for (const value of [undefined, '', '/privacy', 'javascript:alert(1)', 'http://notice.example.test/privacy',
        'https:////notice.example.test', 'https://@notice.example.test',
        'https://u:p@notice.example.test/privacy', 'https://notice.example.test/privacy?child=123',
        'https://notice.example.test:8443/privacy', 'https://notice.example.test/pri\nvacy',
        'https://notice.example.test\\@other.example.test/privacy', 'https://notice.example.test/%0aprivacy',
        `https://notice.example.test/${'a'.repeat(2048)}`]) {
        assert.throws(() => loadParentRegistrationPolicy({ ...env, PARENT_PRIVACY_NOTICE_URL: value }, loadRegistrationPolicy(base)), /HTTPS privacy notice URL/u);
    }
    assert.equal(loadParentRegistrationPolicy({ ...env, PARENT_PRIVACY_NOTICE_URL: 'https://NOTICE.example.test:443/privacy#children' },
        loadRegistrationPolicy(base))?.privacyNoticeUrl, 'https://notice.example.test/privacy#children');
});
