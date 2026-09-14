/**
 * Auth router route contract (TypeDoc surface).
 *
 * Responsibility:
 * - Describes the stable HTTP contract for routes mounted by the auth router.
 *
 * Non-responsibilities:
 * - Express wiring/middleware (owned by the router module).
 * - Token verification and session policy (owned by controllers/handlers).
 *
 * Invariants:
 * - Method + path pairs are stable; changes are breaking.
 * - `verify-token` is safe/idempotent; it does not mutate server state.
 * - `logout` clears the `session` cookie (if present) and returns `{ loggedOut: true }`.
 */

import type { RouteContract } from './routeContract';

/**
 * GET /verify-token request.
 *
 * Notes:
 * - This endpoint consumes auth context from a signed cookie (`session`) or `Authorization: Bearer <token>`.
 * - No request body is used.
 *
 * @category Backend — DTOs
 */
export type VerifyTokenRequest = Record<string, never>;

/**
 * GET /verify-token response body.
 *
 * @category Backend — DTOs
 */
export type VerifyTokenResponse = {
    loggedIn: boolean;
    user_name?: string | null;
};

/**
 * POST /logout request (no body used).
 *
 * @category Backend — DTOs
 */
export type LogoutRequest = Record<string, never>;

/**
 * POST /logout response body.
 *
 * @category Backend — DTOs
 */
export type LogoutResponse = {
    loggedOut: true;
};

/** Explicit same-origin cookie renewal; ordinary sessions are never upgraded. */
export type RenewSessionRequest = Record<string, never>;
export type RenewSessionResponse = VerifyTokenResponse | {
    error: 'INVALID_REQUEST' | 'SESSION_RENEWAL_UNAVAILABLE' | 'RATE_LIMITED';
};

/** Password reauthentication and explicit confirmation; account identity comes from the session. */
export type DeleteAccountRequest = { password: string; confirmation: 'DELETE' };
export type DeleteAccountResponse = { deleted: true } | {
    error: 'UNAUTHENTICATED' | 'INVALID_REQUEST' | 'INVALID_PASSWORD'
        | 'RATE_LIMITED' | 'ACCOUNT_DELETION_UNAVAILABLE' | 'ACCOUNT_DELETION_PENDING';
};

/** @category Backend — Contracts */
export type AuthRoutesContract = {
    readonly routes: readonly (
        | RouteContract<VerifyTokenRequest, VerifyTokenResponse>
        | RouteContract<RenewSessionRequest, RenewSessionResponse>
        | RouteContract<LogoutRequest, LogoutResponse>
        | RouteContract<DeleteAccountRequest, DeleteAccountResponse>
    )[];
};

/** @category Backend — Contracts */
export const authRoutesContract: AuthRoutesContract = {
    routes: [
        {
            id: 'auth.renewSession',
            method: 'POST',
            path: '/renew',
            auth: 'public',
            request: {} as RenewSessionRequest,
            response: { loggedIn: false } as RenewSessionResponse,
        },
        {
            id: 'auth.deleteAccount',
            method: 'POST',
            path: '/delete-account',
            auth: 'user',
            request: {} as DeleteAccountRequest,
            response: { deleted: true } as DeleteAccountResponse,
        },
        {
            id: 'auth.verifyToken',
            method: 'GET',
            path: '/verify-token',
            auth: 'public',
            request: {} as VerifyTokenRequest,
            response: { loggedIn: false } as VerifyTokenResponse,
        },
        {
            id: 'auth.logout',
            method: 'POST',
            path: '/logout',
            auth: 'public',
            request: {} as LogoutRequest,
            response: { loggedOut: true } as LogoutResponse,
        },
    ],
};
