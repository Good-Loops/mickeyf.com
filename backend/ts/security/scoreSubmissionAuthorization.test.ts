import assert from 'node:assert/strict';
import test from 'node:test';
import { Request } from 'express';
import { authorizeScoreSubmission } from './scoreSubmissionAuthorization';
import { issueSessionToken } from './sessionPolicy';

const secret = 'unit-test-secret-that-is-not-a-runtime-credential';
const account = { userId: 42, userName: 'verified-user', accountId: '123e4567-e89b-42d3-a456-426614174000' };
const session = issueSessionToken(account, secret);
const identity = { ...account, sessionId: session.sessionId };

function scoreRequest(
    body: unknown,
    options: { token?: string; bearer?: boolean } = {}
): Pick<Request, 'body' | 'headers' | 'signedCookies'> {
    const token = options.token;
    return {
        body,
        headers: options.bearer && token ? { authorization: `Bearer ${token}` } : {},
        signedCookies: !options.bearer && token ? { __session: token } : {},
    } as Pick<Request, 'body' | 'headers' | 'signedCookies'>;
}

function validToken(): string {
    return session.token;
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
    for (const score of [995, 1001, 1010]) {
        assert.deepEqual(
            authorizeScoreSubmission(scoreRequest({ p4_score: score }, { token: validToken() }), secret),
            { authorized: false, status: 400, error: 'INVALID_SCORE' }
        );
    }
});

test('completion at 1000 is authorized with either existing authentication transport', () => {
    for (const bearer of [false, true]) {
        assert.deepEqual(
            authorizeScoreSubmission(scoreRequest({ p4_score: 1000 }, { token: validToken(), bearer }), secret),
            { authorized: true, identity, score: 1000 }
        );
    }
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
        identity,
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
