/**
 * Main controller for the operation-multiplexed `/api/users` endpoint.
 * Untrusted payloads are validated before any database or password work, and
 * unexpected failures are deliberately left to the application error handler.
 */
import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import type { Pool } from 'mysql2/promise';
import {
    readP4VegaLeaderboard,
    submitP4VegaScore,
} from '../leaderboards/p4VegaScoreRepository';
import {
    createPasswordAccount,
    findPasswordLoginAccount,
    isAccountIdentifierTaken,
} from '../accounts/passwordAccountRepository';
import { authorizeScoreSubmission } from '../security/scoreSubmissionAuthorization';
import { clearAuthenticationCookies, NATIVE_SESSION_COOKIE, WEB_SESSION_COOKIE, sessionCookieOptions } from '../security/sessionCookie';
import { issueSessionToken } from '../security/sessionPolicy';
import { createAccountSession, revokeAccountSession } from '../auth/accountSessionRepository';
import { authenticateRequest } from '../security/requestAuthentication';
import { hasAllowedMutationOrigin, isJsonMutationRequest } from '../security/mutationRequest';
import {
    operationType,
    validateLoginRequest,
    validateSignupRequest,
} from '../security/userRequestValidation';

type ControllerDependencies = {
    database: Pick<Pool, 'getConnection' | 'query'>;
    sessionSecret: string;
    isProduction: boolean;
    p4VegaScoreSubmissionsEnabled: boolean;
    allowedMutationOrigins: readonly string[];
};

// A fixed, valid bcrypt hash keeps nonexistent-account checks on the same
// expensive comparison path without representing any usable credential.
const DUMMY_PASSWORD_HASH = '$2a$10$b3R9u5f4ObGVED5kC8jxp.xvN3FnQzuhcXzAa9iSYcQBkgL4Nv/ee';
const PASSWORD_HASH_COST = 10;

export function createMainController({
    database,
    sessionSecret,
    isProduction,
    p4VegaScoreSubmissionsEnabled,
    allowedMutationOrigins,
}: ControllerDependencies) {
    async function addUser(req: Request, res: Response) {
        const validation = validateSignupRequest(req.body);
        if (!validation.valid) {
            return res.json({ error: validation.error });
        }

        const { userName, email, password } = validation.input;
        if (await isAccountIdentifierTaken(database, { userName, email })) {
            // Keep the established client contract: the conflict status is in
            // the response body rather than the HTTP status.
            return res.json({ error: 'DUPLICATE_USER', status: 409 });
        }

        const passwordHash = await bcrypt.hash(password, PASSWORD_HASH_COST);
        const result = await createPasswordAccount(database, { userName, email, passwordHash });
        if (result === 'duplicate') {
            return res.json({ error: 'DUPLICATE_USER', status: 409 });
        }
        return res.json({ success: true });
    }

    async function loginUser(req: Request, res: Response) {
        if (!isJsonMutationRequest(req) || typeof req.headers.origin !== 'string'
            || !allowedMutationOrigins.includes(req.headers.origin)) {
            return res.status(403).json({ error: 'AUTH_FAILED' });
        }
        const validation = validateLoginRequest(req.body);
        if (!validation.valid) {
            return res.json({ error: 'AUTH_FAILED' });
        }

        const { userName, password, rememberMe } = validation.input;
        const user = await findPasswordLoginAccount(database, userName);
        const passwordMatches = await bcrypt.compare(
            password,
            user?.passwordHash ?? DUMMY_PASSWORD_HASH
        );

        if (!user || user.passwordHash === null || !passwordMatches) {
            return res.json({ error: 'AUTH_FAILED' });
        }

        // Replacing this browser's cookie must not leave its previous credential usable.
        // Revoke only after password proof; a failed replacement requires another login.
        const previous = authenticateRequest(req, sessionSecret);
        if (previous.authenticated) {
            const { userId, accountId, sessionId } = previous.identity;
            await revokeAccountSession(database, userId, accountId, sessionId);
        }

        const session = issueSessionToken({ userId: user.userId, userName: user.userName,
            accountId: user.accountId }, sessionSecret, rememberMe);
        if (!await createAccountSession(database, { userId: user.userId, accountId: user.accountId },
            session.sessionId, session.expiresAt, user.passwordHash, rememberMe)) {
            return res.json({ error: 'AUTH_FAILED' });
        }
        const cookieName = req.headers.origin === 'capacitor://localhost' ? NATIVE_SESSION_COOKIE : WEB_SESSION_COOKIE;
        clearAuthenticationCookies(res, isProduction);
        res.cookie(cookieName, session.token, {
            ...sessionCookieOptions(isProduction, cookieName),
            maxAge: session.maxAge,
        });
        return res.json({ success: true, user_name: user.userName });
    }

    async function submitScore(req: Request, res: Response) {
        if (!p4VegaScoreSubmissionsEnabled) {
            // This gate runs before authentication so operations can probe a
            // frozen revision without allowing it to acquire a DB connection.
            return res.status(503).json({ error: 'SUBMISSIONS_FROZEN' });
        }
        if (!isJsonMutationRequest(req) || !hasAllowedMutationOrigin(req, allowedMutationOrigins)) {
            return res.status(403).json({ error: 'UNAUTHORIZED' });
        }

        const authorization = authorizeScoreSubmission(req, sessionSecret);
        if (!authorization.authorized) {
            return res.status(authorization.status).json({ error: authorization.error });
        }

        const personalBest = await submitP4VegaScore(
            database,
            authorization.identity.userId,
            authorization.score,
            authorization.identity
        );

        if (personalBest === null) {
            return res.status(401).json({ error: 'UNAUTHORIZED' });
        }
        return res.json({ success: true, personalBest });
    }

    async function getLeaderboard(_req: Request, res: Response) {
        const rows = await readP4VegaLeaderboard(database);
        return res.json({
            success: true,
            leaderboard: rows.map(({ userName, score }) => ({
                user_name: userName,
                p4_score: score,
            })),
        });
    }

    return async function mainController(req: Request, res: Response) {
        switch (operationType(req.body)) {
            case 'signup':
                return addUser(req, res);
            case 'login':
                return loginUser(req, res);
            case 'submit_score':
                return submitScore(req, res);
            case 'get_leaderboard':
                return getLeaderboard(req, res);
            default:
                return res.json({ error: 'INVALID_TYPE' });
        }
    };
}
