/**
 * Main controller for the operation-multiplexed `/api/users` endpoint.
 * Untrusted payloads are validated before any database or password work, and
 * unexpected failures are deliberately left to the application error handler.
 */
import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { User } from '../types/customTypes';
import { authorizeScoreSubmission } from '../security/scoreSubmissionAuthorization';
import { sessionCookieOptions } from '../security/sessionCookie';
import {
    operationType,
    validateLoginRequest,
    validateSignupRequest,
} from '../security/userRequestValidation';

type ControllerDependencies = {
    database: Pick<Pool, 'query'>;
    sessionSecret: string;
    isProduction: boolean;
};

type LoginUserRow = RowDataPacket & Pick<User, 'user_id' | 'user_name' | 'user_password'>;

// A fixed, valid bcrypt hash keeps nonexistent-account checks on the same
// expensive comparison path without representing any usable credential.
const DUMMY_PASSWORD_HASH = '$2a$10$b3R9u5f4ObGVED5kC8jxp.xvN3FnQzuhcXzAa9iSYcQBkgL4Nv/ee';
const PASSWORD_HASH_COST = 10;
const SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const DATABASE_QUERY_TIMEOUT_MS = 10_000;

export function createMainController({
    database,
    sessionSecret,
    isProduction,
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
        const validation = validateLoginRequest(req.body);
        if (!validation.valid) {
            return res.json({ error: 'AUTH_FAILED' });
        }

        const { userName, password } = validation.input;
        const [rows] = await database.query<LoginUserRow[]>(
            {
                sql: `SELECT user_id, user_name, user_password
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

        const token = jwt.sign(
            { user_id: user.user_id, user_name: user.user_name },
            sessionSecret,
            { algorithm: 'HS256', expiresIn: '4h' }
        );

        res.cookie('session', token, {
            ...sessionCookieOptions(isProduction),
            maxAge: SESSION_MAX_AGE_MS,
        });
        return res.json({ success: true, token, user_name: user.user_name });
    }

    async function submitScore(req: Request, res: Response) {
        const authorization = authorizeScoreSubmission(req, sessionSecret);
        if (!authorization.authorized) {
            return res.status(authorization.status).json({ error: authorization.error });
        }

        const [result] = await database.query<ResultSetHeader>(
            {
                sql: `UPDATE users
                    SET p4_score = ?
                    WHERE user_id = ?
                    AND (p4_score IS NULL OR p4_score < ?)`,
                timeout: DATABASE_QUERY_TIMEOUT_MS,
            },
            [authorization.score, authorization.identity.userId, authorization.score]
        );

        return res.json({ success: true, personalBest: result.affectedRows === 1 });
    }

    async function getLeaderboard(_req: Request, res: Response) {
        const [rows] = await database.query<RowDataPacket[]>(
            {
                sql: `SELECT user_name, p4_score
                    FROM users
                    WHERE p4_score IS NOT NULL
                    ORDER BY p4_score DESC
                    LIMIT 10`,
                timeout: DATABASE_QUERY_TIMEOUT_MS,
            }
        );
        return res.json({ success: true, leaderboard: rows });
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
