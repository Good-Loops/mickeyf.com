import { createHmac } from 'node:crypto';
import jwt, { JwtPayload } from 'jsonwebtoken';
import {
    isCanonicalV4RunId,
    isValidThreeBossesCompletionTimeMs,
    LEADERBOARD_CONTRACT_VERSION,
    ThreeBossesRunSubmissionRequest,
    ThreeBossesRunTicketRequest,
} from './leaderboardContract';
import { THREE_BOSSES_RULES_VERSION } from './gameCatalog';

const RUN_TICKET_KEY_CONTEXT = 'three-bosses-run-ticket:v1';
const RUN_TICKET_ISSUER = 'mickeyf-backend';
const RUN_TICKET_AUDIENCE = 'three-bosses-run-submission';
const RUN_TICKET_PURPOSE = 'three-bosses-ranked-run';

export const THREE_BOSSES_RUN_TICKET_TTL_SECONDS = 30 * 60;
export const THREE_BOSSES_RUN_TICKET_MAX_LENGTH = 2_048;
export const THREE_BOSSES_RUN_TICKET_ISSUANCE_TOLERANCE_MS = 2_500;

export type IssuedThreeBossesRunTicket = Readonly<{
    runTicket: string;
    expiresAt: string;
}>;

type ThreeBossesRunTicketClaims = JwtPayload & {
    purpose: typeof RUN_TICKET_PURPOSE;
    runId: string;
    contractVersion: typeof LEADERBOARD_CONTRACT_VERSION;
    rulesVersion: typeof THREE_BOSSES_RULES_VERSION;
    startedAtMs: number;
    expiresAtMs: number;
};

/** Derives a purpose-specific key so a run ticket cannot authenticate a session. */
export function createThreeBossesRunTicketSigningKey(sessionSecret: string): Buffer {
    if (typeof sessionSecret !== 'string' || sessionSecret.length === 0) {
        throw new TypeError('Three Bosses run tickets require a session secret.');
    }

    return createHmac('sha256', sessionSecret)
        .update(RUN_TICKET_KEY_CONTEXT, 'utf8')
        .digest();
}

export function issueThreeBossesRunTicket(
    sessionSecret: string,
    userId: number,
    request: ThreeBossesRunTicketRequest,
    nowMs = Date.now()
): IssuedThreeBossesRunTicket {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw new TypeError('Three Bosses run tickets require a valid user ID.');
    }
    if (
        request.contractVersion !== LEADERBOARD_CONTRACT_VERSION
        || request.rulesVersion !== THREE_BOSSES_RULES_VERSION
        || !isCanonicalV4RunId(request.runId)
    ) {
        throw new TypeError('Three Bosses run tickets require a valid run identity.');
    }
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new TypeError('Three Bosses run tickets require a valid issue time.');
    }

    const issuedAtSeconds = Math.floor(nowMs / 1_000);
    const expiresAtMs = nowMs + THREE_BOSSES_RUN_TICKET_TTL_SECONDS * 1_000;
    const expiresAtSeconds = Math.ceil(expiresAtMs / 1_000);
    const runTicket = jwt.sign(
        {
            iss: RUN_TICKET_ISSUER,
            aud: RUN_TICKET_AUDIENCE,
            sub: String(userId),
            jti: request.runId,
            purpose: RUN_TICKET_PURPOSE,
            runId: request.runId,
            contractVersion: request.contractVersion,
            rulesVersion: request.rulesVersion,
            startedAtMs: nowMs,
            expiresAtMs,
            iat: issuedAtSeconds,
            exp: expiresAtSeconds,
        } satisfies ThreeBossesRunTicketClaims,
        createThreeBossesRunTicketSigningKey(sessionSecret),
        { algorithm: 'HS256' }
    );

    if (runTicket.length > THREE_BOSSES_RUN_TICKET_MAX_LENGTH) {
        throw new Error('The generated Three Bosses run ticket is unexpectedly large.');
    }

    return {
        runTicket,
        expiresAt: new Date(expiresAtMs).toISOString(),
    };
}

/**
 * Validates signed run identity and the one server-checkable timing invariant:
 * active combat time cannot exceed wall time since the ranked run began.
 */
export function verifyThreeBossesRunTicket(
    sessionSecret: string,
    userId: number,
    submission: ThreeBossesRunSubmissionRequest,
    nowMs = Date.now()
): boolean {
    if (
        !Number.isSafeInteger(userId)
        || userId <= 0
        || !Number.isSafeInteger(nowMs)
        || nowMs < 0
        || submission.contractVersion !== LEADERBOARD_CONTRACT_VERSION
        || submission.rulesVersion !== THREE_BOSSES_RULES_VERSION
        || !isCanonicalV4RunId(submission.runId)
        || !isValidThreeBossesCompletionTimeMs(submission.completionTimeMs)
        || typeof submission.runTicket !== 'string'
        || submission.runTicket.length === 0
        || submission.runTicket.length > THREE_BOSSES_RUN_TICKET_MAX_LENGTH
    ) {
        return false;
    }

    try {
        const decoded = jwt.verify(
            submission.runTicket,
            createThreeBossesRunTicketSigningKey(sessionSecret),
            {
                algorithms: ['HS256'],
                issuer: RUN_TICKET_ISSUER,
                audience: RUN_TICKET_AUDIENCE,
                subject: String(userId),
                jwtid: submission.runId,
                clockTimestamp: Math.floor(nowMs / 1_000),
            }
        );
        if (typeof decoded !== 'object' || decoded === null) return false;

        const claims = decoded as ThreeBossesRunTicketClaims;
        if (
            claims.purpose !== RUN_TICKET_PURPOSE
            || claims.runId !== submission.runId
            || claims.contractVersion !== submission.contractVersion
            || claims.rulesVersion !== submission.rulesVersion
            || !Number.isSafeInteger(claims.startedAtMs)
            || claims.startedAtMs < 0
            || !Number.isSafeInteger(claims.expiresAtMs)
            || claims.expiresAtMs - claims.startedAtMs
                !== THREE_BOSSES_RUN_TICKET_TTL_SECONDS * 1_000
            || !Number.isSafeInteger(claims.iat)
            || Math.floor(claims.startedAtMs / 1_000) !== claims.iat
            || !Number.isSafeInteger(claims.exp)
            || Math.ceil(claims.expiresAtMs / 1_000) !== claims.exp
            || nowMs >= claims.expiresAtMs
        ) {
            return false;
        }

        const elapsedWallTimeMs = nowMs - claims.startedAtMs;
        return elapsedWallTimeMs >= -THREE_BOSSES_RUN_TICKET_ISSUANCE_TOLERANCE_MS
            && submission.completionTimeMs
                <= elapsedWallTimeMs + THREE_BOSSES_RUN_TICKET_ISSUANCE_TOLERANCE_MS;
    } catch {
        return false;
    }
}
