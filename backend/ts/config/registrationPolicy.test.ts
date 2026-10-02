import assert from 'node:assert/strict';
import test from 'node:test';
import { decideRegistration, loadRegistrationPolicy, registrationPolicyForCreation } from './registrationPolicy';

// ZZ/XY are synthetic fixtures, not legal rules or enabled territories.
const env = { REGISTRATION_ENABLED: 'true', REGISTRATION_POLICY_REVIEWED: 'true',
    REGISTRATION_POLICY_VERSION: 'synthetic-test-v1',
    REGISTRATION_COUNTRY_RULES: JSON.stringify({ ZZ: { parentRequiredBelow: 15 }, XY: { parentRequiredBelow: 18 } }) };
const input = { country: 'ZZ', ageBand: 'minor', policyVersion: env.REGISTRATION_POLICY_VERSION };

test('creation switch preserves existing defaults and rejects misspelled deployment flags', () => {
    const policy = loadRegistrationPolicy(env)!;
    assert.equal(registrationPolicyForCreation(policy, {}), policy);
    assert.equal(registrationPolicyForCreation(policy, { REGISTRATION_CREATION_ENABLED: 'true' }), policy);
    assert.equal(registrationPolicyForCreation(policy, { REGISTRATION_CREATION_ENABLED: 'false' }), undefined);
    assert.equal(registrationPolicyForCreation(undefined, { REGISTRATION_CREATION_ENABLED: 'true' }), undefined);
    for (const value of ['', 'FALSE', '0', 'false ']) {
        assert.throws(() => registrationPolicyForCreation(policy, { REGISTRATION_CREATION_ENABLED: value }), /must be true or false/);
    }
});

test('registration stays closed by default and requires exact reviewed activation', () => {
    for (const enabled of [undefined, 'false', 'TRUE', '1']) {
        assert.equal(loadRegistrationPolicy({ ...env, REGISTRATION_ENABLED: enabled }), undefined);
    }
    for (const reviewed of [undefined, 'false', 'TRUE', '1']) {
        assert.throws(() => loadRegistrationPolicy({ ...env, REGISTRATION_POLICY_REVIEWED: reviewed }), /reviewed/);
    }
    assert.deepEqual(decideRegistration(undefined, input), { allowed: false, reason: 'REGISTRATION_CLOSED' });
});

test('synthetic country rules yield only explicit minor/adult admissions and never verify a parent', () => {
    const policy = loadRegistrationPolicy(env);
    assert.deepEqual(decideRegistration(policy, input), { allowed: true, country: 'ZZ', ageBand: 'minor' });
    assert.deepEqual(decideRegistration(policy, { ...input, ageBand: 'adult' }), { allowed: true, country: 'ZZ', ageBand: 'adult' });
    assert.deepEqual(decideRegistration(policy, { ...input, ageBand: 'parent-required' }), { allowed: false, reason: 'PARENT_REQUIRED' });
    assert.deepEqual(decideRegistration(policy, { ...input, country: 'XY' }), { allowed: false, reason: 'INVALID_REGISTRATION' });
});

test('unconfigured countries, stale policy, invented fields, DOB and nonstring age bands fail closed', () => {
    const policy = loadRegistrationPolicy(env);
    for (const invalid of [null, [], {}, { ...input, country: 'US' }, { ...input, country: '__proto__' },
        { ...input, country: 'zz' }, { ...input, policyVersion: 'old' }, { ...input, ageBand: null },
        { ...input, ageBand: { toString() { throw new Error('must not coerce'); } } },
        { ...input, dateOfBirth: '2000-01-01' }, { ...input, parentApproved: true }]) {
        assert.deepEqual(decideRegistration(policy, invalid), { allowed: false, reason: 'INVALID_REGISTRATION' });
    }
});

test('country configuration has strict bounded shape with no guessed fallback', () => {
    for (const raw of ['', 'null', '[]', '{}', '{"ZZ":{"parentRequiredBelow":0}}',
        '{"ZZ":{"parentRequiredBelow":19}}', '{"ZZ":{"parentRequiredBelow":15.5}}',
        '{"ZZ":{"parentRequiredBelow":"15"}}', '{"ZZ":{"parentRequiredBelow":15,"fallback":true}}']) {
        assert.throws(() => loadRegistrationPolicy({ ...env, REGISTRATION_COUNTRY_RULES: raw }), /valid country rules/);
    }
});

test('policy digest is canonical and changes with either rule or version', () => {
    const original = loadRegistrationPolicy(env)!;
    assert(original.digest.equals(loadRegistrationPolicy({ ...env,
        REGISTRATION_COUNTRY_RULES: '{"XY":{"parentRequiredBelow":18},"ZZ":{"parentRequiredBelow":15}}' })!.digest));
    assert(!original.digest.equals(loadRegistrationPolicy({ ...env, REGISTRATION_POLICY_VERSION: 'v2' })!.digest));
    assert(!original.digest.equals(loadRegistrationPolicy({ ...env,
        REGISTRATION_COUNTRY_RULES: '{"XY":{"parentRequiredBelow":18},"ZZ":{"parentRequiredBelow":16}}' })!.digest));
});
