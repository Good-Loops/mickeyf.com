import { Request } from 'express';
import {
    isCanonicalV4RunId,
    isValidThreeBossesCompletionTimeMs,
    LEADERBOARD_CONTRACT_VERSION,
    ThreeBossesRunSubmissionRequest,
    ThreeBossesRunTicketRequest,
} from './leaderboardContract';
import { THREE_BOSSES_RULES_VERSION } from './gameCatalog';
import { THREE_BOSSES_RUN_TICKET_MAX_LENGTH } from './threeBossesRunTicket';

const EXPECTED_SUBMISSION_KEYS = Object.freeze([
    'completionTimeMs',
    'contractVersion',
    'rulesVersion',
    'runId',
    'runTicket',
]);
const EXPECTED_TICKET_REQUEST_KEYS = Object.freeze([
    'contractVersion',
    'rulesVersion',
    'runId',
]);

export type ThreeBossesRunValidationResult =
    | { valid: true; input: ThreeBossesRunSubmissionRequest }
    | {
          valid: false;
          error:
              | 'UNSUPPORTED_CONTRACT_VERSION'
              | 'UNSUPPORTED_RULES_VERSION'
              | 'INVALID_RUN';
      };

export type ThreeBossesRunTicketValidationResult =
    | { valid: true; input: ThreeBossesRunTicketRequest }
    | {
          valid: false;
          error:
              | 'UNSUPPORTED_CONTRACT_VERSION'
              | 'UNSUPPORTED_RULES_VERSION'
              | 'INVALID_RUN';
      };

type SubmissionSecurityRequest = Pick<Request, 'headers' | 'signedCookies'>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(
    body: Record<string, unknown>,
    expectedKeys: readonly string[]
): boolean {
    const keys = Object.keys(body).sort();
    return keys.length === expectedKeys.length
        && keys.every((key, index) => key === expectedKeys[index]);
}

function validateVersionedRunIdentity(
    body: Record<string, unknown>
): ThreeBossesRunTicketValidationResult {
    if (body.contractVersion !== LEADERBOARD_CONTRACT_VERSION) {
        return { valid: false, error: 'UNSUPPORTED_CONTRACT_VERSION' };
    }
    if (body.rulesVersion !== THREE_BOSSES_RULES_VERSION) {
        return { valid: false, error: 'UNSUPPORTED_RULES_VERSION' };
    }
    if (!isCanonicalV4RunId(body.runId)) {
        return { valid: false, error: 'INVALID_RUN' };
    }

    return {
        valid: true,
        input: {
            contractVersion: LEADERBOARD_CONTRACT_VERSION,
            rulesVersion: THREE_BOSSES_RULES_VERSION,
            runId: body.runId,
        },
    };
}

/** Accepts JSON media types with optional parameters, but no type coercion. */
export function isJsonSubmissionRequest(
    req: Pick<Request, 'headers'>
): boolean {
    const contentType = req.headers['content-type'];
    if (typeof contentType !== 'string') return false;
    const [mediaType] = contentType.split(';', 1);
    return mediaType.trim().toLowerCase() === 'application/json';
}

/**
 * Cookie-authenticated mutations require an exact trusted browser Origin.
 * Bearer-only non-browser clients may omit Origin; if they send one, it must
 * still match the configured allow-list exactly.
 */
export function hasAllowedThreeBossesMutationOrigin(
    req: SubmissionSecurityRequest,
    allowedOrigins: readonly string[]
): boolean {
    const origin = req.headers.origin;
    if (origin !== undefined) {
        return typeof origin === 'string' && allowedOrigins.includes(origin);
    }

    const signedSession = req.signedCookies?.session;
    return !(typeof signedSession === 'string' && signedSession.length > 0);
}

/** Validates the exact version-one wire shape without accepting extra keys. */
export function validateThreeBossesRunSubmission(
    body: unknown
): ThreeBossesRunValidationResult {
    if (!isPlainObject(body)) {
        return { valid: false, error: 'INVALID_RUN' };
    }

    if (!hasExactKeys(body, EXPECTED_SUBMISSION_KEYS)) {
        return { valid: false, error: 'INVALID_RUN' };
    }

    const identity = validateVersionedRunIdentity(body);
    if (!identity.valid) return identity;
    if (
        !isValidThreeBossesCompletionTimeMs(body.completionTimeMs)
        || typeof body.runTicket !== 'string'
        || body.runTicket.length === 0
        || body.runTicket.length > THREE_BOSSES_RUN_TICKET_MAX_LENGTH
    ) {
        return { valid: false, error: 'INVALID_RUN' };
    }

    return {
        valid: true,
        input: {
            contractVersion: LEADERBOARD_CONTRACT_VERSION,
            rulesVersion: THREE_BOSSES_RULES_VERSION,
            runId: identity.input.runId,
            completionTimeMs: body.completionTimeMs,
            runTicket: body.runTicket,
        },
    };
}

/** Validates the exact request used to start one ranked Three Bosses run. */
export function validateThreeBossesRunTicketRequest(
    body: unknown
): ThreeBossesRunTicketValidationResult {
    if (!isPlainObject(body) || !hasExactKeys(body, EXPECTED_TICKET_REQUEST_KEYS)) {
        return { valid: false, error: 'INVALID_RUN' };
    }

    return validateVersionedRunIdentity(body);
}
