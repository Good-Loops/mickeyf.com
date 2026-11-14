import assert from 'node:assert/strict';
import test from 'node:test';
import { Request } from 'express';
import { loadRuntimeConfig } from '../config/runtimeConfig';
import { authorizeThreeBossesMutation } from './threeBossesMutationAuthorization';
import { issueSessionToken } from './sessionPolicy';

const secret = 'unit-test-secret-that-is-not-a-runtime-credential';
const account = { userId: 42, userName: 'verified-user', accountId: '123e4567-e89b-42d3-a456-426614174000' };
const session = issueSessionToken(account, secret);
const identity = { ...account, sessionId: session.sessionId };
const allowedOrigin = 'https://mickeyf.example';
const options = {
    submissionsEnabled: true,
    sessionSecret: secret,
    allowedMutationOrigins: [allowedOrigin],
};
const unauthorized = { authorized: false, status: 401, error: 'UNAUTHORIZED' };

function validToken(): string {
    return session.token;
}

function mutationRequest(
    headers: Request['headers'] = {},
    signedCookies: Request['signedCookies'] = { __session: validToken() }
): Pick<Request, 'headers' | 'signedCookies'> {
    return {
        headers: { origin: allowedOrigin, 'content-type': 'application/json', ...headers },
        signedCookies,
    };
}

test('the packaged iOS origin permits transport, not unauthenticated score changes', () => {
    const nativeOptions = {
        ...options,
        allowedMutationOrigins: loadRuntimeConfig({
            NODE_ENV: 'production', SESSION_SECRET: secret,
        }).corsOrigins,
    };
    const nativeHeaders = { origin: 'capacitor://localhost' };
    assert.deepEqual(
        authorizeThreeBossesMutation(mutationRequest(nativeHeaders, {}), nativeOptions),
        unauthorized
    );
    assert.equal(
        authorizeThreeBossesMutation(mutationRequest(nativeHeaders), nativeOptions).authorized,
        true
    );
    assert.deepEqual(
        authorizeThreeBossesMutation(mutationRequest({
            origin: 'capacitor://localhost.evil.example',
        }), nativeOptions),
        unauthorized
    );
});

test('disabled submissions take precedence over invalid authentication, origin, and content type', () => {
    const request = mutationRequest({ origin: 'https://untrusted.example', 'content-type': 'text/plain' }, {});

    assert.deepEqual(
        authorizeThreeBossesMutation(request, { ...options, submissionsEnabled: false, sessionSecret: '' }),
        { authorized: false, status: 403, error: 'SUBMISSION_DISABLED' }
    );
});

test('missing or invalid authentication keeps the 401 contract before content validation', () => {
    for (const signedCookies of [{}, { session: 'invalid-token' }]) {
        assert.deepEqual(
            authorizeThreeBossesMutation(mutationRequest({ 'content-type': 'text/plain' }, signedCookies), options),
            unauthorized
        );
    }
});

test('missing authentication configuration remains a 401 response for Three Bosses', () => {
    assert.deepEqual(
        authorizeThreeBossesMutation(mutationRequest(), { ...options, sessionSecret: '' }),
        unauthorized
    );
});

test('cookie authentication requires an allowed origin before content validation', () => {
    for (const origin of [undefined, 'https://untrusted.example']) {
        assert.deepEqual(
            authorizeThreeBossesMutation(mutationRequest({ origin, 'content-type': 'text/plain' }), options),
            unauthorized
        );
    }
});

test('Bearer clients cannot bypass a disallowed explicit origin', () => {
    const request = mutationRequest({
        authorization: `Bearer ${validToken()}`,
        origin: 'https://untrusted.example',
    }, {});

    assert.deepEqual(authorizeThreeBossesMutation(request, options), unauthorized);
});

test('authenticated requests with an allowed origin still require JSON', () => {
    assert.deepEqual(
        authorizeThreeBossesMutation(mutationRequest({ 'content-type': 'text/plain' }), options),
        { authorized: false, status: 400, error: 'INVALID_RUN' }
    );
});

test('signed-cookie requests return only the verified identity', () => {
    assert.deepEqual(authorizeThreeBossesMutation(mutationRequest(), options), {
        authorized: true,
        identity,
    });
});

test('Bearer-only clients can omit origin and receive the verified identity', () => {
    const request = mutationRequest({ authorization: `Bearer ${validToken()}`, origin: undefined }, {});

    assert.deepEqual(authorizeThreeBossesMutation(request, options), {
        authorized: true,
        identity,
    });
});
