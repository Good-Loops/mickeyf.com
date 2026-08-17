import assert from 'node:assert/strict';
import test from 'node:test';
import { Request } from 'express';
import {
    isAuthenticationOperation,
    isLoginOperation,
    loginAccountRateLimitKey,
} from './requestRateLimits';

test('only signup and login operations use the stricter authentication limiter', () => {
    assert.equal(isAuthenticationOperation({ body: { type: 'signup' } }), true);
    assert.equal(isAuthenticationOperation({ body: { type: 'login' } }), true);
    assert.equal(isAuthenticationOperation({ body: { type: 'get_leaderboard' } }), false);
    assert.equal(isLoginOperation({ body: { type: 'signup' } }), false);
    assert.equal(isLoginOperation({ body: { type: 'login' } }), true);
});

test('account rate-limit keys are normalized and do not disclose usernames', () => {
    const first = loginAccountRateLimitKey({
        body: { user_name: ' Player-One ' },
        ip: '127.0.0.1',
    } as Pick<Request, 'body' | 'ip'>);
    const second = loginAccountRateLimitKey({
        body: { user_name: 'player-one' },
        ip: '203.0.113.5',
    } as Pick<Request, 'body' | 'ip'>);

    assert.equal(first, second);
    assert.match(first, /^account:[a-f0-9]{64}$/);
    assert.equal(first.includes('player-one'), false);
});

test('malformed account identifiers fall back to a normalized IP key', () => {
    const key = loginAccountRateLimitKey({
        body: { user_name: '' },
        ip: '2001:db8::1',
    } as Pick<Request, 'body' | 'ip'>);
    assert.match(key, /^ip:/);
});
