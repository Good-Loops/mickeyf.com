import assert from 'node:assert/strict';
import test from 'node:test';
import { Request } from 'express';
import {
    hasAllowedThreeBossesMutationOrigin,
    isJsonSubmissionRequest,
    validateThreeBossesRunSubmission,
    validateThreeBossesRunTicketRequest,
} from './threeBossesRunRequest';
import { THREE_BOSSES_RUN_TICKET_MAX_LENGTH } from './threeBossesRunTicket';

const validRun = Object.freeze({
    contractVersion: 1,
    rulesVersion: 1,
    runId: '123e4567-e89b-42d3-a456-426614174000',
    completionTimeMs: 50_000,
    runTicket: 'signed-run-ticket',
});
const validTicketRequest = Object.freeze({
    contractVersion: validRun.contractVersion,
    rulesVersion: validRun.rulesVersion,
    runId: validRun.runId,
});

test('accepts only the exact version-one plain JSON shape', () => {
    assert.deepEqual(validateThreeBossesRunSubmission(validRun), {
        valid: true,
        input: validRun,
    });

    for (const body of [
        null,
        [],
        { ...validRun, score: 2_000 },
        { ...validRun, completionTimeMs: undefined },
        { ...validRun, runTicket: undefined },
        Object.assign(Object.create(null), validRun),
    ]) {
        assert.deepEqual(validateThreeBossesRunSubmission(body), {
            valid: false,
            error: 'INVALID_RUN',
        });
    }
});

test('projects version errors separately from invalid run fields', () => {
    assert.deepEqual(validateThreeBossesRunSubmission({
        ...validRun,
        contractVersion: 2,
    }), {
        valid: false,
        error: 'UNSUPPORTED_CONTRACT_VERSION',
    });
    assert.deepEqual(validateThreeBossesRunSubmission({
        ...validRun,
        rulesVersion: 2,
    }), {
        valid: false,
        error: 'UNSUPPORTED_RULES_VERSION',
    });

    for (const body of [
        { ...validRun, runId: validRun.runId.toUpperCase() },
        { ...validRun, runId: '123e4567-e89b-12d3-a456-426614174000' },
        { ...validRun, completionTimeMs: 0 },
        { ...validRun, completionTimeMs: 9_999 },
        { ...validRun, completionTimeMs: 86_400_001 },
        { ...validRun, completionTimeMs: 1.5 },
        { ...validRun, completionTimeMs: '50000' },
        { ...validRun, runTicket: '' },
        { ...validRun, runTicket: 'x'.repeat(THREE_BOSSES_RUN_TICKET_MAX_LENGTH + 1) },
    ]) {
        assert.deepEqual(validateThreeBossesRunSubmission(body), {
            valid: false,
            error: 'INVALID_RUN',
        });
    }
});

test('accepts only an exact versioned run-ticket request', () => {
    assert.deepEqual(validateThreeBossesRunTicketRequest(validTicketRequest), {
        valid: true,
        input: validTicketRequest,
    });

    for (const body of [
        null,
        [],
        { ...validTicketRequest, completionTimeMs: 50_000 },
        { ...validTicketRequest, runId: validTicketRequest.runId.toUpperCase() },
        Object.assign(Object.create(null), validTicketRequest),
    ]) {
        assert.deepEqual(validateThreeBossesRunTicketRequest(body), {
            valid: false,
            error: 'INVALID_RUN',
        });
    }

    assert.deepEqual(validateThreeBossesRunTicketRequest({
        ...validTicketRequest,
        contractVersion: 2,
    }), {
        valid: false,
        error: 'UNSUPPORTED_CONTRACT_VERSION',
    });
    assert.deepEqual(validateThreeBossesRunTicketRequest({
        ...validTicketRequest,
        rulesVersion: 2,
    }), {
        valid: false,
        error: 'UNSUPPORTED_RULES_VERSION',
    });
});

test('requires application/json while allowing standard media-type parameters', () => {
    for (const contentType of ['application/json', 'Application/JSON; charset=utf-8']) {
        assert.equal(isJsonSubmissionRequest({
            headers: { 'content-type': contentType },
        } as Pick<Request, 'headers'>), true);
    }
    for (const contentType of [undefined, 'text/plain', 'application/problem+json']) {
        assert.equal(isJsonSubmissionRequest({
            headers: contentType ? { 'content-type': contentType } : {},
        } as Pick<Request, 'headers'>), false);
    }
});

test('requires an allowed Origin for cookie auth and any caller that sends Origin', () => {
    const allowedOrigins = ['https://mickeyf.com', 'http://localhost:5173'];
    const request = (
        origin: string | undefined,
        signedSession: string | undefined
    ) => ({
        headers: origin ? { origin } : {},
        signedCookies: signedSession ? { session: signedSession } : {},
    } as Pick<Request, 'headers' | 'signedCookies'>);

    assert.equal(hasAllowedThreeBossesMutationOrigin(
        request('https://mickeyf.com', 'signed-token'),
        allowedOrigins
    ), true);
    assert.equal(hasAllowedThreeBossesMutationOrigin(
        request('http://localhost:5173', 'signed-token'),
        allowedOrigins
    ), true);
    assert.equal(hasAllowedThreeBossesMutationOrigin(
        request(undefined, 'signed-token'),
        allowedOrigins
    ), false);
    assert.equal(hasAllowedThreeBossesMutationOrigin(
        request('https://evil.example', 'signed-token'),
        allowedOrigins
    ), false);
    assert.equal(hasAllowedThreeBossesMutationOrigin(
        request(undefined, undefined),
        allowedOrigins
    ), true);
    assert.equal(hasAllowedThreeBossesMutationOrigin(
        request('https://evil.example', undefined),
        allowedOrigins
    ), false);
});
