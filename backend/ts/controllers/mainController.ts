/**
 * Main controller: HTTP handlers for core API endpoints (non-auth).
 *
 * Responsibility:
 * - Implements request/response contracts for core routes owned by the main router.
 * - Orchestrates persistence operations for these endpoints.
 *
 * Non-responsibilities:
 * - Route mounting and URL design (owned by routers).
 * - Cross-cutting concerns like auth middleware, CORS, and error middleware (owned by app/router wiring).
 * - Database pool construction and environment parsing (owned by config).
 *
 * Side effects:
 * - Reads/writes user records in persistence and may emit logs depending on endpoint behavior.
 *
 * Trust boundary:
 * - Treats inbound request data as untrusted; authorization assumptions must be enforced by middleware.
 */
import { Request, Response } from 'express';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { User } from '../types/customTypes';
import { pool } from '../db/dbConfig';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authorizeScoreSubmission } from '../security/scoreSubmissionAuthorization';

/**
 * Main request multiplexer for `/api/users`.
 *
 * Request contract:
 * - Reads: `req.body.type` to select an operation.
 *
 * Response contract:
 * - Status: implicit 200 in most paths (no explicit status set here), except where delegated handlers set it.
 * - Body: operation-specific JSON payloads; unknown `type` yields `{ error: 'INVALID_TYPE' }`.
 *
 * Side effects:
 * - Delegates to handlers that may read/write persistence and set cookies.
 */
export async function mainController(req: Request, res: Response) {
    switch (req.body.type) {
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

/**
 * Creates a new user.
 *
 * Request contract:
 * - Reads: `req.body.user_name`, `req.body.email`, `req.body.user_password`.
 *
 * Response contract:
 * - Status: implicit 200 (no explicit status set).
 * - Body: `{ success: true }` or `{ error: <code> }`.
 * - Note: duplicate user returns `{ error: 'DUPLICATE_USER', status: 409 }` in the JSON body without setting the HTTP
 *   status code.
 *
 * Side effects:
 * - Reads from persistence to detect duplicates.
 * - Hashes the password and inserts a new user record.
 *
 * Failure modes:
 * - Input validation failures return JSON error codes.
 * - Persistence/other errors return `{ error: 'SERVER_ERROR' }` or `{ error: 'UNEXPECTED_ERROR' }`.
 */
const addUser = async (req: Request, res: Response) => {
    const { user_name, email, user_password } = req.body as User;
    let result = await pool.query('SELECT * FROM users WHERE user_name = ? OR email = ?', [user_name, email]);
    if (!user_name || !email) {
        return res.json({ error: 'EMPTY_FIELDS' });
    }
    else if (user_password.length < 8 || user_password.length > 16) {
        return res.json({ error: 'INVALID_PASSWORD' });
    }
    else if (email.indexOf('@') === -1 && email.indexOf('.') === -1 && email.length < 5) {
        return res.json({ error: 'INVALID_EMAIL' });
    }
    else if (Array.isArray(result[0]) && result[0].length > 0) {
        return res.json({ error: 'DUPLICATE_USER', status: 409 });
    }

    /** Bcrypt cost factor for password hashing performed by this controller. */
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(user_password, saltRounds);

    try {
        // Insert user into database
        await pool.query(
            'INSERT INTO users (user_name, email, user_password) VALUES (?, ?, ?)',
            [user_name, email, hashedPassword]
        );
        res.json({ success: true });
    } catch (error) {
        if (error instanceof Error) {
            res.json({ error: 'SERVER_ERROR' });
        } else {
            res.json({ error: 'UNEXPECTED_ERROR' });
        }
    }
};

/**
 * Authenticates a user and establishes a signed session cookie.
 *
 * Request contract:
 * - Reads: `req.body.user_name`, `req.body.user_password`.
 *
 * Response contract:
 * - Status: implicit 200 (no explicit status set).
 * - Body: `{ success: true, token: string, user_name: string }` or `{ error: <code>, message?: string }`.
 * - Cookies/session: sets a signed, httpOnly `session` cookie on success.
 *
 * Side effects:
 * - Reads user record from persistence.
 * - Verifies password via bcrypt.
 * - Issues a JWT token and sets it as a signed cookie.
 * - Logs errors on unexpected failures.
 *
 * Failure modes:
 * - Invalid credentials return `{ error: 'AUTH_FAILED' }`.
 * - Unexpected errors return `{ error: 'SERVER_ERROR', message }` or `{ error: 'UNEXPECTED_ERROR' }`.
 */
const loginUser = async (req: Request, res: Response) => {
    const { user_name, user_password } = req.body as User;
    try {
        /**
         * Controller-local helper that returns the first row of a query result (or null).
         *
         * Used to keep DB lookup logic localized to this handler without changing the response contract.
         */
        async function fetchOne<T>(
            query: string,
            values: any[]
        ): Promise<T | null> {
            const [rows] = await pool.query<RowDataPacket[]>(query, values);
            return rows.length > 0 ? (rows[0] as T) : null;
        }

        const user = await fetchOne<User>(
            'SELECT * FROM users WHERE user_name = ?',
            [user_name]
        );

        if (user) {
            const isPasswordCorrect = await bcrypt.compare(user_password, user.user_password);
            if (isPasswordCorrect) {
                /**
                 * Token issuance contract used by this handler.
                 *
                 * Invariants:
                 * - JWT `expiresIn: '4h'` is mirrored by the cookie `maxAge` (milliseconds) below.
                 * - Cookie name is `session` and is signed because the app uses a signing secret in cookie-parser.
                 */
                const token = jwt.sign({ user_id: user.user_id, user_name: user.user_name }, process.env.SESSION_SECRET!, { expiresIn: '4h' });

                const isProd = process.env.NODE_ENV === 'production';
                res.cookie('session', token, {
                    httpOnly: true,
                    secure: isProd,      // true on https
                    sameSite: isProd ? 'none' : 'lax', // if you serve frontend on a different domain with https use 'none'
                    signed: true,        // because app.ts uses cookieParser(process.env.SESSION_SECRET)
                    maxAge: 4 * 60 * 60 * 1000, // 4 hours, same as token
                });

                res.json({ success: true, token: token, user_name: user.user_name });
            } else {
                res.json({ error: 'AUTH_FAILED' });
            }
        } else {
            res.json({ error: 'AUTH_FAILED' });
        }
    } catch (error) {
        console.error('Login error:', error);
        if (error instanceof Error) {
            res.json({ error: 'SERVER_ERROR', message: error.message });
        } else {
            res.json({ error: 'UNEXPECTED_ERROR' });
        }
    }
};

/**
 * Submits a user's p4-Vega score.
 *
 * Request contract:
 * - Reads: `req.body.p4_score` and optional legacy `req.body.user_name`.
 * - Authenticates: signed `session` cookie or Bearer JWT.
 *
 * Response contract:
 * - Status: 400 for invalid scores, 401 for missing/invalid authentication,
 *   403 for a legacy body username that conflicts with the authenticated identity,
 *   otherwise 200 on success.
 * - Body: `{ success: true, personalBest: boolean }` on success.
 *
 * Side effects:
 * - Reads the current score from persistence and conditionally updates it.
 *
 * Failure modes:
 * - Persistence/other errors return status 500 with `{ error: 'SERVER_ERROR' }`.
 */
const submitScore = async (req: Request, res: Response) => {
    const authorization = authorizeScoreSubmission(req);
    if (!authorization.authorized) {
        return res.status(authorization.status).json({ error: authorization.error });
    }

    try {
        const [result] = await pool.query<ResultSetHeader>(
            `UPDATE users
                SET p4_score = ?
                WHERE user_id = ?
                AND (p4_score IS NULL OR p4_score < ?)`,
            [authorization.score, authorization.identity.userId, authorization.score]
        );

        return res.json({ success: true, personalBest: result.affectedRows === 1 });
    } catch (error) {
        return res.status(500).json({ error: 'SERVER_ERROR' });
    }
};

/**
 * Retrieves leaderboard entries.
 *
 * Request contract:
 * - Reads: no request fields (the request object is unused).
 *
 * Response contract:
 * - Status: 200 on success; 500 on failure.
 * - Body: `{ success: true, leaderboard: rows }` on success; `{ error: 'SERVER_ERROR' }` on failure.
 *
 * Side effects:
 * - Reads from persistence (top 10 users with non-null scores, ordered descending).
 * - Logs error details on failure.
 */
const getLeaderboard = async (_req: Request, res: Response) => {
    try {
        const [rows] = await pool.query(
            `SELECT user_name, p4_score 
                FROM users 
                WHERE p4_score IS NOT NULL 
                ORDER BY p4_score DESC 
                LIMIT 10`
        );
        res.json({ success: true, leaderboard: rows });
    } catch (error: unknown) {
        const msg =
            error instanceof Error ? error.message : JSON.stringify(error); 
        console.error('Leaderboard error:', msg);
        res.status(500).json({ error: 'SERVER_ERROR' });
    }
};
