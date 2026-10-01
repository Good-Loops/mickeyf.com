import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRegistrationPolicy } from './registrationPolicy';
import { loadParentRegistrationPolicy } from './parentRegistrationPolicy';
const base = { REGISTRATION_ENABLED: 'true', REGISTRATION_POLICY_REVIEWED: 'true', REGISTRATION_POLICY_VERSION: 'test',
    REGISTRATION_COUNTRY_RULES: '{"ZZ":{"parentRequiredBelow":16}}' };
const env = { ...base, PARENT_REGISTRATION_ENABLED: 'true', PARENT_REGISTRATION_POLICY_REVIEWED: 'true',
    PARENT_REGISTRATION_POLICY_VERSION: 'parent-test', PARENT_CONSENT_VERSION: 'consent-test', PARENT_CONSENT_TEXT: 'Synthetic consent only.',
    PARENT_REGISTRATION_COUNTRIES: '["ZZ"]', PROVIDER_AUTH_ENABLED: 'true', ACCOUNT_DELETION_ENABLED: 'true', APPLE_MAINTENANCE_HTTP_ENABLED: 'true' };
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
