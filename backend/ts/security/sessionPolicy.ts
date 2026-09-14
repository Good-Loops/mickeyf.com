import jwt from 'jsonwebtoken';
import { createHmac, randomBytes } from 'node:crypto';
import { isAccountId } from '../accounts/deletionJournal';

export const SESSION_PURPOSE = 'ludolume-session';
export const SESSION_VERSION = 2;
export const STANDARD_SESSION_SECONDS = 4 * 60 * 60;
export const PERSISTENT_SESSION_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_RENEWAL_INTERVAL_SECONDS = 15 * 60;
export const SESSION_RENEWAL_GRACE_SECONDS = 2 * 60;

export type SessionAccount = Readonly<{ userId: number; userName: string; accountId: string }>;
export type SessionProof = Readonly<{ accountId: string; sessionId: string }>;

export function isSessionId(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
        && Buffer.from(value, 'base64url').toString('base64url') === value;
}

export function sessionSigningKey(secret: string): Buffer {
    if (!secret) throw new TypeError('Session signing configuration is required.');
    return createHmac('sha256', secret).update('ludolume-session:v2').digest();
}

/** A concurrent retry can recover the same successor without storing raw credentials. */
export function deriveRenewedSessionId(sessionId: string, secret: string): string {
    if (!secret || !isSessionId(sessionId)) throw new TypeError('Valid session renewal configuration is required.');
    return createHmac('sha256', secret).update(`ludolume-session-renewal:v1:${sessionId}`).digest('base64url');
}

/** Renewal timestamps come from the committed session row, never the request body. */
export function issueRenewedSessionToken(account: SessionAccount, secret: string,
    renewal: Readonly<{ sessionId: string; issuedAt: number; expiresAt: number }>): string {
    if (!secret || !Number.isSafeInteger(account.userId) || account.userId <= 0
        || !isAccountId(account.accountId) || typeof account.userName !== 'string' || !account.userName
        || !isSessionId(renewal.sessionId) || !Number.isSafeInteger(renewal.issuedAt) || renewal.issuedAt <= 0
        || !Number.isSafeInteger(renewal.expiresAt) || renewal.expiresAt <= renewal.issuedAt
        || renewal.expiresAt - renewal.issuedAt > PERSISTENT_SESSION_SECONDS) {
        throw new TypeError('Valid account and committed renewal metadata are required.');
    }
    return jwt.sign({ purpose: SESSION_PURPOSE, version: SESSION_VERSION,
        user_id: account.userId, user_name: account.userName, account_uuid: account.accountId,
        jti: renewal.sessionId, iat: renewal.issuedAt, exp: renewal.expiresAt },
    sessionSigningKey(secret), { algorithm: 'HS256' });
}

/** Durations are selected on the server, never accepted as arbitrary client input. */
export function sessionLifetimeSeconds(staySignedIn: boolean): number {
    return staySignedIn ? PERSISTENT_SESSION_SECONDS : STANDARD_SESSION_SECONDS;
}

export function issueSessionToken(account: SessionAccount, secret: string, staySignedIn = false, nowMs = Date.now()) {
    if (!secret || !Number.isSafeInteger(account.userId) || account.userId <= 0
        || typeof account.userName !== 'string' || account.userName.length === 0
        || !isAccountId(account.accountId) || typeof staySignedIn !== 'boolean'
        || !Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new TypeError('Valid account and session configuration are required.');
    }
    const issuedAt = Math.floor(nowMs / 1000);
    const lifetime = sessionLifetimeSeconds(staySignedIn);
    const sessionId = randomBytes(32).toString('base64url');
    const token = jwt.sign({ purpose: SESSION_PURPOSE, version: SESSION_VERSION,
        user_id: account.userId, user_name: account.userName, account_uuid: account.accountId,
        jti: sessionId,
        iat: issuedAt, exp: issuedAt + lifetime }, sessionSigningKey(secret), { algorithm: 'HS256' });
    return { token, sessionId, expiresAt: issuedAt + lifetime, maxAge: lifetime * 1000 };
}
