/**
 * Authorization and input-validation boundary for p4-Vega score writes.
 *
 * Keeping this decision separate from persistence makes the HTTP failure
 * contract testable without opening a database connection.
 */
import { Request } from 'express';
import {
    authenticateRequest,
    AuthenticatedIdentity,
} from './requestAuthentication';
import { isValidP4VegaScore } from './p4VegaScorePolicy';

type ScoreSubmissionRequest = Pick<Request, 'body' | 'headers' | 'signedCookies'>;

export type ScoreSubmissionAuthorization =
    | {
          authorized: true;
          identity: AuthenticatedIdentity;
          score: number;
      }
    | {
          authorized: false;
          status: 400 | 401 | 403 | 500;
          error: 'INVALID_SCORE' | 'UNAUTHORIZED' | 'IDENTITY_MISMATCH' | 'SERVER_ERROR';
      };

export function authorizeScoreSubmission(
    req: ScoreSubmissionRequest,
    secret: string | undefined = process.env.SESSION_SECRET
): ScoreSubmissionAuthorization {
    const authentication = authenticateRequest(req, secret);
    if (!authentication.authenticated) {
        if (authentication.reason === 'AUTH_CONFIGURATION_ERROR') {
            return { authorized: false, status: 500, error: 'SERVER_ERROR' };
        }
        return { authorized: false, status: 401, error: 'UNAUTHORIZED' };
    }

    const body = req.body as unknown;
    if (typeof body !== 'object' || body === null) {
        return { authorized: false, status: 400, error: 'INVALID_SCORE' };
    }

    const { p4_score, user_name } = body as Record<string, unknown>;
    if (!isValidP4VegaScore(p4_score)) {
        return { authorized: false, status: 400, error: 'INVALID_SCORE' };
    }

    if (user_name !== undefined && user_name !== authentication.identity.userName) {
        return { authorized: false, status: 403, error: 'IDENTITY_MISMATCH' };
    }

    return {
        authorized: true,
        identity: authentication.identity,
        score: p4_score,
    };
}
