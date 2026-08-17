import assert from 'node:assert/strict';
import test from 'node:test';
import { operationType, validateLoginRequest, validateSignupRequest } from './userRequestValidation';

test('malformed bodies fail safely without throwing', () => {
    for (const body of [undefined, null, [], 'signup', { type: 'signup' }]) {
        assert.doesNotThrow(() => validateSignupRequest(body));
        assert.equal(validateSignupRequest(body).valid, false);
    }
    assert.equal(operationType(null), null);
    assert.equal(operationType({ type: 5 }), null);
});

test('signup validation normalizes safe fields and permits strong passwords over the old 16-character cap', () => {
    const password = 'a-valid-password-that-is-longer-than-sixteen';
    assert.deepEqual(validateSignupRequest({
        user_name: '  Player One  ',
        email: '  PLAYER@Example.COM ',
        user_password: password,
    }), {
        valid: true,
        input: {
            userName: 'Player One',
            email: 'player@example.com',
            password,
        },
    });
});

test('signup validation rejects malformed emails, control characters, and passwords over 72 UTF-8 bytes', () => {
    assert.deepEqual(validateSignupRequest({
        user_name: 'player',
        email: 'invalid@example',
        user_password: 'valid-password',
    }), { valid: false, error: 'INVALID_EMAIL' });

    assert.deepEqual(validateSignupRequest({
        user_name: 'player\nadmin',
        email: 'player@example.com',
        user_password: 'valid-password',
    }), { valid: false, error: 'INVALID_USERNAME' });

    assert.deepEqual(validateSignupRequest({
        user_name: 'player',
        email: 'player@example.com',
        user_password: 'x'.repeat(73),
    }), { valid: false, error: 'INVALID_PASSWORD' });

    assert.deepEqual(validateSignupRequest({
        user_name: 'player',
        email: 'player@example.com',
        user_password: 'é'.repeat(37),
    }), { valid: false, error: 'INVALID_PASSWORD' });
});

test('login validation returns one generic invalid result for unsafe credentials', () => {
    assert.deepEqual(validateLoginRequest({ user_name: '', user_password: 'anything' }), { valid: false });
    assert.deepEqual(validateLoginRequest({ user_name: 'player', user_password: 1234 }), { valid: false });
    assert.deepEqual(validateLoginRequest({ user_name: 'player', user_password: 'é'.repeat(37) }), { valid: false });
    assert.equal(validateLoginRequest({ user_name: ' player ', user_password: 'valid' }).valid, true);
});
