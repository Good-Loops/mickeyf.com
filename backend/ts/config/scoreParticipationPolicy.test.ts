import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRegistrationPolicy } from './registrationPolicy';
import { loadScoreParticipationPolicy, mayPublishScores } from './scoreParticipationPolicy';

const registration = loadRegistrationPolicy({ REGISTRATION_ENABLED: 'true', REGISTRATION_POLICY_REVIEWED: 'true',
    REGISTRATION_POLICY_VERSION: 'synthetic-reg', REGISTRATION_COUNTRY_RULES: '{"ZZ":{"parentRequiredBelow":13}}' })!;
const env = { PUBLIC_SCORE_PARTICIPATION_ENABLED: 'true', PUBLIC_SCORE_POLICY_REVIEWED: 'true', PUBLIC_SCORE_ASSURANCE_REVIEWED: 'true',
    PROVIDER_AUTH_ENABLED: 'true', ACCOUNT_DELETION_ENABLED: 'true', PUBLIC_SCORE_POLICY_VERSION: 'synthetic-v1',
    PUBLIC_SCORE_CONSENT_VERSION: 'synthetic-c1', PUBLIC_SCORE_CONSENT_TEXT: 'Synthetic separate score disclosure permission.',
    PUBLIC_SCORE_PRIVACY_NOTICE_URL: 'https://notice.example.test/privacy',
    PUBLIC_SCORE_COUNTRY_RULES: '{"ZZ":{"selfAgeBands":["minor","adult"],"parentManaged":false}}' };

test('publication has no default region or inferred legal/provider assurance', () => {
    assert.equal(loadScoreParticipationPolicy({}), undefined);
    for (const field of ['PUBLIC_SCORE_POLICY_REVIEWED', 'PUBLIC_SCORE_ASSURANCE_REVIEWED', 'PROVIDER_AUTH_ENABLED', 'ACCOUNT_DELETION_ENABLED']) {
        assert.throws(() => loadScoreParticipationPolicy({ ...env, [field]: 'false' }, registration));
    }
    for (const rules of ['{}', 'null', '{"US":{"selfAgeBands":["adult"],"parentManaged":false}}',
        '{"ZZ":{"selfAgeBands":["minor","minor"],"parentManaged":false}}',
        '{"ZZ":{"selfAgeBands":["adult"],"parentManaged":true}}']) {
        assert.throws(() => loadScoreParticipationPolicy({ ...env, PUBLIC_SCORE_COUNTRY_RULES: rules }, registration));
    }
});

test('reviewed self minor route is separate from parent authority and unknown/stale profiles remain closed', () => {
    const policy = loadScoreParticipationPolicy(env, registration)!;
    const profile = { country: 'ZZ', ageBand: 'minor', registrationVersion: registration.version };
    assert.equal(mayPublishScores(policy, profile, 'self'), true);
    assert.equal(mayPublishScores(policy, profile, 'parent'), false);
    assert.equal(mayPublishScores(policy, { ...profile, country: 'US' }, 'self'), false);
    assert.equal(mayPublishScores(policy, { ...profile, registrationVersion: 'stale' }, 'self'), false);
    assert.equal(mayPublishScores(undefined, profile, 'self'), false);
    assert.equal(mayPublishScores(policy, null, 'self'), false);
});

test('disclosure text, rules, notice and regional registration changes invalidate publication policy digests', () => {
    const original = loadScoreParticipationPolicy(env, registration)!;
    for (const patch of [{ PUBLIC_SCORE_CONSENT_TEXT: 'Different disclosed terms.' }, { PUBLIC_SCORE_PRIVACY_NOTICE_URL: 'https://notice.example.test/new' },
        { PUBLIC_SCORE_COUNTRY_RULES: '{"ZZ":{"selfAgeBands":["adult"],"parentManaged":false}}' }]) {
        assert.equal(original.digest.equals(loadScoreParticipationPolicy({ ...env, ...patch }, registration)!.digest), false);
    }
    assert.equal(original.digest.equals(loadScoreParticipationPolicy(env, { ...registration, digest: Buffer.alloc(32) })!.digest), false);
});
