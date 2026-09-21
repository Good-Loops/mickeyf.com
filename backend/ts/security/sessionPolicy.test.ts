import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { verifyRequestToken } from './requestAuthentication';
import { deriveRenewedSessionId, issueRenewedSessionToken, issueSessionToken, isSessionId, sessionSigningKey, STANDARD_SESSION_SECONDS, PERSISTENT_SESSION_SECONDS } from './sessionPolicy';

const account = { userId: 7, userName: 'session-test', accountId: '11111111-2222-4333-8444-555555555555' };
const secret = 'synthetic-session-policy-secret';

test('only explicit server-selected Apple provenance is signed, preserved and verified', () => {
    const apple = issueSessionToken(account, secret, true, Date.now(), 'apple');
    const authenticated = verifyRequestToken(apple.token, secret);
    assert.ok(authenticated.authenticated);
    assert.equal(authenticated.identity.authenticationMethod, 'apple');
    const now = Math.floor(Date.now() / 1000);
    const renewed = issueRenewedSessionToken(account, secret, {
        sessionId: deriveRenewedSessionId(apple.sessionId, secret), issuedAt: now,
        expiresAt: now + PERSISTENT_SESSION_SECONDS,
    }, authenticated.identity.authenticationMethod);
    const authentication = verifyRequestToken(renewed, secret);
    assert.ok(authentication.authenticated);
    assert.equal(authentication.identity.authenticationMethod, 'apple');
    const password = issueSessionToken({ ...account, authenticationMethod: 'apple' } as typeof account, secret);
    assert.equal((jwt.decode(password.token) as jwt.JwtPayload).authenticationMethod, undefined);
    assert.throws(() => issueSessionToken(account, secret, false, Date.now(), 'google' as 'apple'), TypeError);
    const claims = jwt.decode(apple.token) as jwt.JwtPayload;
    for (const authenticationMethod of ['google', null, true, 'apple\n']) {
        const invalid = jwt.sign({ ...claims, authenticationMethod }, sessionSigningKey(secret));
        assert.equal(verifyRequestToken(invalid, secret).authenticated, false);
    }
});

test('renewal retries derive the same canonical credential with a separate domain', () => {
    const original = issueSessionToken(account, secret, true);
    const nextId = deriveRenewedSessionId(original.sessionId, secret);
    assert.ok(isSessionId(nextId));
    assert.equal(nextId, deriveRenewedSessionId(original.sessionId, secret));
    assert.notEqual(nextId, original.sessionId);
    assert.notEqual(nextId, deriveRenewedSessionId(original.sessionId, 'different-secret'));
    assert.notEqual(nextId, deriveRenewedSessionId(nextId, secret));
    assert.notEqual(nextId, sessionSigningKey(secret).toString('base64url'));
    assert.throws(() => deriveRenewedSessionId('invalid', secret), TypeError);
});

test('renewal signs committed timestamps identically and caps each credential at thirty days', () => {
    const original = issueSessionToken(account, secret, true);
    const issuedAt = Math.floor(Date.now() / 1000);
    const renewal = { sessionId: deriveRenewedSessionId(original.sessionId, secret),
        issuedAt, expiresAt: issuedAt + PERSISTENT_SESSION_SECONDS };
    const token = issueRenewedSessionToken(account, secret, renewal);
    assert.equal(token, issueRenewedSessionToken(account, secret, renewal));
    const claims = jwt.verify(token, sessionSigningKey(secret)) as jwt.JwtPayload;
    assert.equal(claims.iat, renewal.issuedAt);
    assert.equal(claims.exp, renewal.expiresAt);
    assert.equal(claims.jti, renewal.sessionId);
    assert.equal(claims.version, 2);
    assert.throws(() => issueRenewedSessionToken(account, secret, { ...renewal, expiresAt: renewal.expiresAt + 1 }), TypeError);
    assert.throws(() => issueRenewedSessionToken(account, secret, { ...renewal, expiresAt: issuedAt }), TypeError);
});

test('server-selected lifetimes align token and cookie expiry without storing the password', () => {
    const now = Date.now();
    for (const [remember, duration] of [[false, STANDARD_SESSION_SECONDS], [true, PERSISTENT_SESSION_SECONDS]] as const) {
        const issued = issueSessionToken(account, secret, remember, now);
        const claims = jwt.verify(issued.token, sessionSigningKey(secret)) as jwt.JwtPayload;
        assert.equal(claims.exp! - claims.iat!, duration);
        assert.equal(issued.maxAge, duration * 1000);
        assert.equal(issued.expiresAt, Math.floor(now / 1000) + duration);
        assert.equal(claims.jti, issued.sessionId);
        assert.ok(isSessionId(issued.sessionId));
        assert.equal(claims.account_uuid, account.accountId);
        assert.equal(claims.user_password, undefined);
    }
});

test('each login gets a different identifier and the old verifier cannot accept v2 tokens', () => {
    const a = issueSessionToken(account, secret);
    const b = issueSessionToken(account, secret);
    assert.notEqual(a.sessionId, b.sessionId);
    assert.throws(() => jwt.verify(a.token, secret), /invalid signature/);
    assert.equal(a.maxAge, STANDARD_SESSION_SECONDS * 1000);
});

test('invalid identities, configuration and arbitrary persistence values fail before issuance', () => {
    assert.throws(() => issueSessionToken({ ...account, accountId: 'invalid' }, secret), TypeError);
    assert.throws(() => issueSessionToken(account, ''), TypeError);
    assert.throws(() => issueSessionToken(account, secret, '30d' as unknown as boolean), TypeError);
    assert.equal(isSessionId('x'.repeat(43)), false);
});
