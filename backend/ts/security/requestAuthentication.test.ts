import assert from 'node:assert/strict';
import test from 'node:test';
import { Request } from 'express';
import jwt from 'jsonwebtoken';
import {
    getRequestToken,
    verifyRequestToken,
} from './requestAuthentication';

const secret = 'unit-test-secret-that-is-not-a-runtime-credential';

function authRequest(
    signedCookieToken?: unknown,
    authorization?: string
): Pick<Request, 'headers' | 'signedCookies'> {
    return {
        headers: authorization ? { authorization } : {},
        signedCookies: signedCookieToken === undefined ? {} : { session: signedCookieToken },
    } as Pick<Request, 'headers' | 'signedCookies'>;
}

test('signed session cookie is preferred over Bearer token', () => {
    assert.equal(getRequestToken(authRequest('cookie-token', 'Bearer bearer-token')), 'cookie-token');
});

test('Bearer token is accepted when no valid signed cookie value is present', () => {
    assert.equal(getRequestToken(authRequest(false, 'Bearer bearer-token')), 'bearer-token');
});

test('malformed Authorization headers are rejected', () => {
    assert.equal(getRequestToken(authRequest(undefined, 'Basic credentials')), null);
    assert.equal(getRequestToken(authRequest(undefined, 'Bearer token with spaces')), null);
    assert.equal(getRequestToken(authRequest(undefined, 'bearer token')), null);
});

test('verified token yields its trusted identity claims', () => {
    const token = jwt.sign({ user_id: 42, user_name: 'verified-user' }, secret, { expiresIn: '5m' });
    assert.deepEqual(verifyRequestToken(token, secret), {
        authenticated: true,
        identity: { userId: 42, userName: 'verified-user' },
    });
});

test('invalid signatures and incomplete identity claims are rejected', () => {
    const wrongSignature = jwt.sign({ user_id: 42, user_name: 'verified-user' }, 'wrong-secret');
    const wrongAlgorithm = jwt.sign(
        { user_id: 42, user_name: 'verified-user' },
        secret,
        { algorithm: 'HS512' }
    );
    const missingName = jwt.sign({ user_id: 42 }, secret);
    const invalidId = jwt.sign({ user_id: 0, user_name: 'verified-user' }, secret);

    assert.equal(verifyRequestToken(wrongSignature, secret).authenticated, false);
    assert.equal(verifyRequestToken(wrongAlgorithm, secret).authenticated, false);
    assert.equal(verifyRequestToken(missingName, secret).authenticated, false);
    assert.equal(verifyRequestToken(invalidId, secret).authenticated, false);
});

test('missing authentication configuration fails closed', () => {
    assert.deepEqual(verifyRequestToken('untrusted-token', ''), {
        authenticated: false,
        reason: 'AUTH_CONFIGURATION_ERROR',
    });
});
