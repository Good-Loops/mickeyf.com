/**
 * Main router route contract (TypeDoc surface).
 *
 * Responsibility:
 * - Describes the stable HTTP contract for routes mounted by the main router.
 *
 * Non-responsibilities:
 * - Express wiring/middleware (owned by the router module).
 * - Business logic and persistence behavior (owned by controllers).
 *
 * Invariants:
 * - Method + path pairs are stable; changes are breaking.
 * - Auth level describes expected caller context, not enforcement (middleware is responsible for enforcement).
 */

/**
 * POST /users request body.
 *
 * Responsibility:
 * - Selects an operation via `type` and carries that operation's payload.
 *
 * Invariants:
 * - This is a discriminated union; each `type` has a fixed payload shape.
 * - Unknown/unsupported `type` yields {@link ApiErrorCode} `INVALID_TYPE`.
 *
 * @category Backend — DTOs
 */
export type PostUsersRequest =
    | {
                    /** Operation: create a new user account. */
          type: 'signup';

                    /** Required; trimmed, non-empty, no control characters, at most 64 characters. */
          user_name: string;

                    /**
                     * Required; must be non-empty.
                     *
                     * Trimmed and normalized to lowercase; must have a basic local@domain form and be at most
                     * 254 characters.
                     */
          email: string;

                    /**
                     * Required.
                     *
                     * Validation: at least 8 characters and at most 72 UTF-8 bytes; control characters are rejected.
                     */
          user_password: string;
      }
    | {
                    /** Operation: authenticate an existing user. */
          type: 'login';

                    /** Required. */
          user_name: string;

                    /** Required; at most 72 UTF-8 bytes to match bcrypt's effective input boundary. */
          user_password: string;
      }
    | {
                    /** Operation: submit a p4-Vega score. */
          type: 'submit_score';

                    /**
                     * Legacy compatibility field. The server derives identity from verified authentication and
                     * returns HTTP 403 with `IDENTITY_MISMATCH` if this value conflicts with that identity.
                     */
          user_name?: string;

                    /**
                     * Score value in the range 0–990 (inclusive), in increments of 10.
                     */
          p4_score: number;
      }
    | {
                    /** Operation: fetch the leaderboard. */
          type: 'get_leaderboard';
      };

/**
 * API error codes returned by multiplexer handlers.
 *
 * Invariants:
 * - Codes are stable strings intended for programmatic handling.
 *
 * @category Backend — DTOs
 */
export type ApiErrorCode =
    | 'INVALID_TYPE'
    | 'EMPTY_FIELDS'
    | 'INVALID_USERNAME'
    | 'INVALID_PASSWORD'
    | 'INVALID_EMAIL'
    | 'DUPLICATE_USER'
    | 'AUTH_FAILED'
    | 'UNAUTHORIZED'
    | 'INVALID_SCORE'
    | 'IDENTITY_MISMATCH'
    | 'RATE_LIMITED'
    | 'PAYLOAD_TOO_LARGE'
    | 'INVALID_REQUEST'
    | 'NOT_FOUND'
    | 'SERVER_ERROR'
    | 'UNEXPECTED_ERROR';

/**
 * Error response shape shared by multiple operations.
 *
 * Status vs body:
 * - Many handlers return `{ error: ... }` without `success: false`.
 * - Some handlers include a `status` field in the JSON body (e.g. `DUPLICATE_USER` uses `status: 409`)
 *   without necessarily setting the HTTP status code.
 * - Other handlers set real HTTP statuses (e.g. `UNAUTHORIZED` uses HTTP 401; `SERVER_ERROR` may use HTTP 500).
 *
 * @category Backend — DTOs
 */
export type ApiError = {
    success?: false;
    error: ApiErrorCode;
    message?: string;
    status?: number;
};

/** @category Backend — DTOs */
export type SignupResponse = { success: true } | ApiError;

/** @category Backend — DTOs */
export type LoginResponse =
    | { success: true; token: string; user_name: string }
    | ApiError;

/** @category Backend — DTOs */
export type SubmitScoreResponse =
    | { success: true; personalBest: boolean }
    | ApiError;

/** @category Backend — DTOs */
export type GetLeaderboardResponse =
    | {
          success: true;
          leaderboard: Array<{
              user_name: string;
              p4_score: number | null;
          }>;
      }
    | ApiError;

/**
 * POST /users response body.
 *
 * Notes:
 * - Response is operation-dependent and may include success flags, tokens, leaderboards, or error codes.
 *
 * @category Backend — DTOs
 */
export type PostUsersResponse =
    | SignupResponse
    | LoginResponse
    | SubmitScoreResponse
    | GetLeaderboardResponse;

/**
 * GET /users response body (plain text guidance message).
 *
 * @category Backend — DTOs
 */
export type GetUsersResponse = string;
