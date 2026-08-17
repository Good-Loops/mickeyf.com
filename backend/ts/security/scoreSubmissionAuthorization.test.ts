import assert from 'node:assert/strict';
import test from 'node:test';
import { Request } from 'express';
import jwt from 'jsonwebtoken';
import { authorizeScoreSubmission } from './scoreSubmissionAuthorization';

const secret = 'unit-test-secret-that-is-not-a-runtime-credential';

function scoreRequest(
    body: unknown,
    options: { token?: string; bearer?: boolean } = {}
): Pick<Request, 'body' | 'headers' | 'signedCookies'> {
    const token = options.token;
    return {
        body,
        headers: options.bearer && token ? { authorization: `Bearer ${token}` } : {},
        signedCookies: !options.bearer && token ? { session: token } : {},
    } as Pick<Request, 'body' | 'headers' | 'signedCookies'>;
}

function validToken(): string {
    return jwt.sign({ user_id: 42, user_name: 'verified-user' }, secret, {
        algorithm: 'HS256',
        expiresIn: '5m',
    });
}

test('missing or invalid authentication produces HTTP 401 contract', () => {
    assert.deepEqual(authorizeScoreSubmission(scoreRequest({ p4_score: 10 }), secret), {
        authorized: false,
        status: 401,
        error: 'UNAUTHORIZED',
    });

    assert.deepEqual(
        authorizeScoreSubmission(scoreRequest({ p4_score: 10 }, { token: 'invalid' }), secret),
        { authorized: false, status: 401, error: 'UNAUTHORIZED' }
    );
});

test('missing server authentication configuration produces HTTP 500 contract', () => {
    assert.deepEqual(
        authorizeScoreSubmission(scoreRequest({ p4_score: 10 }, { token: validToken() }), ''),
        { authorized: false, status: 500, error: 'SERVER_ERROR' }
    );
});

test('invalid score produces HTTP 400 contract before persistence', () => {
    assert.deepEqual(
        authorizeScoreSubmission(scoreRequest({ p4_score: 995 }, { token: validToken() }), secret),
        { authorized: false, status: 400, error: 'INVALID_SCORE' }
    );
});

test('body username mismatch produces HTTP 403 contract', () => {
    assert.deepEqual(
        authorizeScoreSubmission(
            scoreRequest(
                { p4_score: 10, user_name: 'different-user' },
                { token: validToken(), bearer: true }
            ),
            secret
        ),
        { authorized: false, status: 403, error: 'IDENTITY_MISMATCH' }
    );
});

test('verified identity is authoritative with matching or omitted legacy username', () => {
    const expected = {
        authorized: true,
        identity: { userId: 42, userName: 'verified-user' },
        score: 990,
    };

    assert.deepEqual(
        authorizeScoreSubmission(
            scoreRequest(
                { p4_score: 990, user_name: 'verified-user' },
                { token: validToken() }
            ),
            secret
        ),
        expected
    );
    assert.deepEqual(
        authorizeScoreSubmission(
            scoreRequest({ p4_score: 990 }, { token: validToken(), bearer: true }),
            secret
        ),
        expected
    );
});
