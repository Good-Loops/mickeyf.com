import assert from 'node:assert/strict';
import test from 'node:test';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { verifyRequestToken } from '../security/requestAuthentication';
import {
    ThreeBossesRunSubmissionRequest,
    ThreeBossesRunTicketRequest,
} from './leaderboardContract';
import {
    createThreeBossesRunTicketSigningKey,
    issueThreeBossesRunTicket,
    THREE_BOSSES_RUN_TICKET_ISSUANCE_TOLERANCE_MS,
    THREE_BOSSES_RUN_TICKET_MAX_LENGTH,
    THREE_BOSSES_RUN_TICKET_TTL_SECONDS,
    verifyThreeBossesRunTicket,
} from './threeBossesRunTicket';

const sessionSecret = 'three-bosses-run-ticket-test-secret';
const nowMs = 1_800_000_000_999;
const userId = 42;
const account = Object.freeze({ userId, accountId: '4bbaec47-5516-47fe-b13e-366bc6ec9814' });
const runId = '123e4567-e89b-42d3-a456-426614174000';
const ticketRequest: ThreeBossesRunTicketRequest = Object.freeze({
    contractVersion: 1,
    rulesVersion: 1,
    runId,
});

function submission(runTicket: string): ThreeBossesRunSubmissionRequest {
    return {
        ...ticketRequest,
        completionTimeMs: 50_000,
        runTicket,
    };
}

test('issues a bounded, domain-separated ticket with exact versioned claims', () => {
    const issued = issueThreeBossesRunTicket(
        sessionSecret,
        account,
        ticketRequest,
        nowMs
    );
    const claims = jwt.decode(issued.runTicket) as JwtPayload;

    assert.ok(issued.runTicket.length <= THREE_BOSSES_RUN_TICKET_MAX_LENGTH);
    assert.equal(
        issued.expiresAt,
        new Date(nowMs + THREE_BOSSES_RUN_TICKET_TTL_SECONDS * 1_000).toISOString()
    );
    assert.deepEqual(claims, {
        iss: 'mickeyf-backend',
        aud: 'three-bosses-run-submission',
        sub: String(userId),
        account_uuid: account.accountId,
        jti: runId,
        purpose: 'three-bosses-ranked-run',
        runId,
        contractVersion: 1,
        rulesVersion: 1,
        startedAtMs: nowMs,
        expiresAtMs: nowMs + THREE_BOSSES_RUN_TICKET_TTL_SECONDS * 1_000,
        iat: Math.floor(nowMs / 1_000),
        exp: Math.ceil(
            (nowMs + THREE_BOSSES_RUN_TICKET_TTL_SECONDS * 1_000) / 1_000
        ),
    });
    assert.equal(
        verifyThreeBossesRunTicket(
            sessionSecret,
            account,
            submission(issued.runTicket),
            nowMs + 50_000
        ),
        true
    );
    assert.deepEqual(verifyRequestToken(issued.runTicket, sessionSecret), {
        authenticated: false,
        reason: 'INVALID_CREDENTIALS',
    });
});

test('binds the ticket to its key, account, run, contract, and rules', () => {
    const issued = issueThreeBossesRunTicket(
        sessionSecret,
        account,
        ticketRequest,
        nowMs
    );
    const validSubmission = submission(issued.runTicket);
    const verificationTime = nowMs + validSubmission.completionTimeMs;

    assert.equal(verifyThreeBossesRunTicket(
        'different-session-secret',
        account,
        validSubmission,
        verificationTime
    ), false);
    assert.equal(verifyThreeBossesRunTicket(
        sessionSecret,
        { ...account, userId: userId + 1 },
        validSubmission,
        verificationTime
    ), false);
    assert.equal(verifyThreeBossesRunTicket(
        sessionSecret,
        account,
        {
            ...validSubmission,
            runId: '123e4567-e89b-42d3-a456-426614174001',
        },
        verificationTime
    ), false);
    assert.equal(verifyThreeBossesRunTicket(
        sessionSecret,
        account,
        { ...validSubmission, contractVersion: 2 as 1 },
        verificationTime
    ), false);
    assert.equal(verifyThreeBossesRunTicket(
        sessionSecret,
        account,
        { ...validSubmission, rulesVersion: 2 as 1 },
        verificationTime
    ), false);
});

test('rejects malformed claims, unsafe algorithms, and oversized tickets', () => {
    const issued = issueThreeBossesRunTicket(
        sessionSecret,
        account,
        ticketRequest,
        nowMs
    );
    const claims = jwt.decode(issued.runTicket) as JwtPayload;
    const signingKey = createThreeBossesRunTicketSigningKey(sessionSecret);
    const wrongPurpose = jwt.sign(
        { ...claims, purpose: 'different-purpose' },
        signingKey,
        { algorithm: 'HS256' }
    );
    const unsigned = jwt.sign(claims, '', { algorithm: 'none' });
    const verificationTime = nowMs + 50_000;

    assert.equal(verifyThreeBossesRunTicket(
        sessionSecret,
        account,
        submission(wrongPurpose),
        verificationTime
    ), false);
    assert.equal(verifyThreeBossesRunTicket(
        sessionSecret,
        account,
        submission(unsigned),
        verificationTime
    ), false);
    assert.equal(verifyThreeBossesRunTicket(
        sessionSecret,
        account,
        submission('x'.repeat(THREE_BOSSES_RUN_TICKET_MAX_LENGTH + 1)),
        verificationTime
    ), false);

    const sessionToken = jwt.sign(
        { user_id: userId, user_name: 'player' },
        sessionSecret,
        { algorithm: 'HS256', expiresIn: '5m' }
    );
    assert.equal(verifyThreeBossesRunTicket(
        sessionSecret,
        account,
        submission(sessionToken),
        verificationTime
    ), false);
});

test('a reused numeric user ID cannot authorize another account incarnation\'s ticket', () => {
    const issued = issueThreeBossesRunTicket(sessionSecret, account, ticketRequest, nowMs);
    const replacement = { ...account, accountId: '4bbaec47-5516-47fe-b13e-366bc6ec9815' };
    assert.equal(verifyThreeBossesRunTicket(
        sessionSecret, replacement, submission(issued.runTicket), nowMs + 50_000
    ), false);
});

test('legacy tickets without a UUID and invalid account UUIDs are rejected', () => {
    const issued = issueThreeBossesRunTicket(sessionSecret, account, ticketRequest, nowMs);
    const legacyClaims = jwt.decode(issued.runTicket) as JwtPayload;
    delete legacyClaims.account_uuid;
    const legacyTicket = jwt.sign(legacyClaims, createThreeBossesRunTicketSigningKey(sessionSecret), {
        algorithm: 'HS256',
    });
    assert.equal(verifyThreeBossesRunTicket(
        sessionSecret, account, submission(legacyTicket), nowMs + 50_000
    ), false);

    for (const accountId of ['', 'not-a-uuid', account.accountId.toUpperCase()]) {
        const invalidAccount = { ...account, accountId };
        assert.throws(() => issueThreeBossesRunTicket(
            sessionSecret, invalidAccount, ticketRequest, nowMs
        ), TypeError);
        assert.equal(verifyThreeBossesRunTicket(
            sessionSecret, invalidAccount, submission(issued.runTicket), nowMs + 50_000
        ), false);
    }
});

test('enforces the 2.5-second issuance tolerance and strict 30-minute expiry', () => {
    const issued = issueThreeBossesRunTicket(
        sessionSecret,
        account,
        ticketRequest,
        nowMs
    );
    const validSubmission = submission(issued.runTicket);
    const earliestAcceptedMs = nowMs
        + validSubmission.completionTimeMs
        - THREE_BOSSES_RUN_TICKET_ISSUANCE_TOLERANCE_MS;

    assert.equal(verifyThreeBossesRunTicket(
        sessionSecret,
        account,
        validSubmission,
        earliestAcceptedMs - 1
    ), false);
    assert.equal(verifyThreeBossesRunTicket(
        sessionSecret,
        account,
        validSubmission,
        earliestAcceptedMs
    ), true);
    assert.equal(verifyThreeBossesRunTicket(
        sessionSecret,
        account,
        validSubmission,
        nowMs + THREE_BOSSES_RUN_TICKET_TTL_SECONDS * 1_000 - 1
    ), true);
    assert.equal(verifyThreeBossesRunTicket(
        sessionSecret,
        account,
        validSubmission,
        nowMs + THREE_BOSSES_RUN_TICKET_TTL_SECONDS * 1_000
    ), false);
});

test('refuses to issue tickets for invalid identity, run, or time inputs', () => {
    assert.throws(
        () => issueThreeBossesRunTicket(sessionSecret, { ...account, userId: 0 }, ticketRequest, nowMs),
        TypeError
    );
    assert.throws(
        () => issueThreeBossesRunTicket(sessionSecret, account, {
            ...ticketRequest,
            runId: ticketRequest.runId.toUpperCase(),
        }, nowMs),
        TypeError
    );
    assert.throws(
        () => issueThreeBossesRunTicket(sessionSecret, account, ticketRequest, -1),
        TypeError
    );
});
