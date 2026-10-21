/** Shared preconditions for Three Bosses ticket issuance and run submission. */
import { Request } from 'express';
import {
    hasAllowedThreeBossesMutationOrigin,
    isJsonSubmissionRequest,
} from '../leaderboards/threeBossesRunRequest';
import {
    authenticateRequest,
    AuthenticatedIdentity,
} from './requestAuthentication';

type ThreeBossesMutationRequest = Pick<Request, 'headers' | 'signedCookies'>;

type ThreeBossesMutationPolicy = {
    submissionsEnabled: boolean;
    sessionSecret: string;
    allowedMutationOrigins: readonly string[];
};

export type ThreeBossesMutationAuthorization =
    | { authorized: true; identity: AuthenticatedIdentity }
    | {
          authorized: false;
          status: 400 | 401 | 403;
          error: 'SUBMISSION_DISABLED' | 'UNAUTHORIZED' | 'INVALID_RUN';
      };

export function authorizeThreeBossesMutation(
    req: ThreeBossesMutationRequest,
    { submissionsEnabled, sessionSecret, allowedMutationOrigins }: ThreeBossesMutationPolicy
): ThreeBossesMutationAuthorization {
    // Order is part of the HTTP contract: disabled always wins, and request
    // format is checked only after authentication and Origin authorization.
    if (!submissionsEnabled) {
        return { authorized: false, status: 403, error: 'SUBMISSION_DISABLED' };
    }

    const authentication = authenticateRequest(req, sessionSecret);
    if (!authentication.authenticated) {
        return { authorized: false, status: 401, error: 'UNAUTHORIZED' };
    }

    if (!hasAllowedThreeBossesMutationOrigin(req, allowedMutationOrigins)) {
        return { authorized: false, status: 401, error: 'UNAUTHORIZED' };
    }

    if (!isJsonSubmissionRequest(req)) {
        return { authorized: false, status: 400, error: 'INVALID_RUN' };
    }

    return { authorized: true, identity: authentication.identity };
}
