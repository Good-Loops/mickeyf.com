import assert from 'node:assert/strict';
import test from 'node:test';
import { Request } from 'express';
import jwt from 'jsonwebtoken';
import { issueSessionToken, sessionSigningKey, PERSISTENT_SESSION_SECONDS } from './sessionPolicy';
import {
    getRequestToken,
    verifyRequestToken,
} from './requestAuthentication';

const secret = 'unit-test-secret-that-is-not-a-runtime-credential';
const account = { userId: 42, userName: 'verified-user', accountId: '11111111-2222-4333-8444-555555555555' };

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
    const issued = issueSessionToken(account, secret);
    assert.deepEqual(verifyRequestToken(issued.token, secret), {
        authenticated: true,
        identity: { ...account, sessionId: issued.sessionId },
    });
});

test('first-party cookie takes precedence and an invalid value cannot downgrade to another identity', () => {
    for (const value of [false, '', 1]) {
        const req = authRequest('native-cookie', 'Bearer bearer-token');
        req.signedCookies.__session = value;
        assert.equal(getRequestToken(req), null);
    }
    const req = authRequest('native-cookie');
    req.signedCookies.__session = 'web-cookie';
    assert.equal(getRequestToken(req), 'web-cookie');
});

test('signed but invalid session purpose, identity, identifier and lifetime claims are rejected', () => {
    const payload = jwt.decode(issueSessionToken(account, secret).token) as jwt.JwtPayload;
    const now = Math.floor(Date.now() / 1000);
    for (const change of [
        { purpose: 'provider-proof' }, { version: 1 }, { account_uuid: 'invalid' },
        { jti: 'not-canonical' }, { user_id: 0 }, { user_name: '' },
        { iat: now + 60 }, { exp: now - 1 },
        { exp: now + PERSISTENT_SESSION_SECONDS + 1 },
        { exp: undefined }, { iat: undefined },
    ]) {
        const claims: jwt.JwtPayload = { ...payload, ...change };
        for (const key of Object.keys(claims)) if (claims[key] === undefined) delete claims[key];
        // jsonwebtoken invents iat when absent unless explicitly disabled.
        const token = jwt.sign(claims, sessionSigningKey(secret), { noTimestamp: change.iat === undefined && 'iat' in change });
        assert.equal(verifyRequestToken(token, secret).authenticated, false, JSON.stringify(change));
    }
});

test('legacy signing keys and other algorithms cannot issue revocable-session credentials', () => {
    const payload = jwt.decode(issueSessionToken(account, secret).token) as jwt.JwtPayload;
    assert.equal(verifyRequestToken(jwt.sign(payload, secret), secret).authenticated, false);
    assert.equal(verifyRequestToken(jwt.sign(payload, sessionSigningKey(secret), { algorithm: 'HS512' }), secret).authenticated, false);
    assert.equal(verifyRequestToken('x'.repeat(8193), secret).authenticated, false);
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
