/**
 * Main controller for the operation-multiplexed `/api/users` endpoint.
 * Untrusted payloads are validated before any database or password work, and
 * unexpected failures are deliberately left to the application error handler.
 */
import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { Pool, RowDataPacket } from 'mysql2/promise';
import {
    readP4VegaLeaderboard,
    submitP4VegaScore,
} from '../leaderboards/p4VegaScoreRepository';
import { User } from '../types/customTypes';
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

type LoginUserRow = RowDataPacket & Pick<User, 'user_id' | 'user_name' | 'user_password'> & { account_uuid: string };

// A fixed, valid bcrypt hash keeps nonexistent-account checks on the same
// expensive comparison path without representing any usable credential.
const DUMMY_PASSWORD_HASH = '$2a$10$b3R9u5f4ObGVED5kC8jxp.xvN3FnQzuhcXzAa9iSYcQBkgL4Nv/ee';
const PASSWORD_HASH_COST = 10;
const DATABASE_QUERY_TIMEOUT_MS = 10_000;

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
        const [existingUsers] = await database.query<RowDataPacket[]>(
            {
                sql: 'SELECT 1 FROM users WHERE user_name = ? OR email = ? LIMIT 1',
                timeout: DATABASE_QUERY_TIMEOUT_MS,
            },
            [userName, email]
        );

        if (existingUsers.length > 0) {
            // Keep the established client contract: the conflict status is in
            // the response body rather than the HTTP status.
            return res.json({ error: 'DUPLICATE_USER', status: 409 });
        }

        const hashedPassword = await bcrypt.hash(password, PASSWORD_HASH_COST);
        await database.query(
            {
                sql: 'INSERT INTO users (user_name, email, user_password) VALUES (?, ?, ?)',
                timeout: DATABASE_QUERY_TIMEOUT_MS,
            },
            [userName, email, hashedPassword]
        );
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
        const [rows] = await database.query<LoginUserRow[]>(
            {
                sql: `SELECT user_id, account_uuid, user_name, user_password
                    FROM users
                    WHERE user_name = ?
                    LIMIT 1`,
                timeout: DATABASE_QUERY_TIMEOUT_MS,
            },
            [userName]
        );
        const user = rows[0];
        const passwordMatches = await bcrypt.compare(
            password,
            user?.user_password ?? DUMMY_PASSWORD_HASH
        );

        if (!user || !passwordMatches) {
            return res.json({ error: 'AUTH_FAILED' });
        }

        // Replacing this browser's cookie must not leave its previous credential usable.
        // Revoke only after password proof; a failed replacement requires another login.
        const previous = authenticateRequest(req, sessionSecret);
        if (previous.authenticated) {
            const { userId, accountId, sessionId } = previous.identity;
            await revokeAccountSession(database, userId, accountId, sessionId);
        }

        const session = issueSessionToken({ userId: user.user_id, userName: user.user_name,
            accountId: user.account_uuid }, sessionSecret, rememberMe);
        if (!await createAccountSession(database, { userId: user.user_id, accountId: user.account_uuid },
            session.sessionId, session.expiresAt, user.user_password)) {
            return res.json({ error: 'AUTH_FAILED' });
        }
        const cookieName = req.headers.origin === 'capacitor://localhost' ? NATIVE_SESSION_COOKIE : WEB_SESSION_COOKIE;
        clearAuthenticationCookies(res, isProduction);
        res.cookie(cookieName, session.token, {
            ...sessionCookieOptions(isProduction, cookieName),
            maxAge: session.maxAge,
        });
        return res.json({ success: true, user_name: user.user_name });
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
