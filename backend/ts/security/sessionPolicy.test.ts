import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { issueSessionToken, isSessionId, sessionSigningKey, STANDARD_SESSION_SECONDS, PERSISTENT_SESSION_SECONDS } from './sessionPolicy';

const account = { userId: 7, userName: 'session-test', accountId: '11111111-2222-4333-8444-555555555555' };
const secret = 'synthetic-session-policy-secret';

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
