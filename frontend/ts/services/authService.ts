/**
 * Frontend authentication service boundary.
 *
 * Purpose:
 * - Wraps backend authentication endpoints into a small, typed API consumed by UI/context layers.
 *
 * Role:
 * - Owns request construction and response parsing for auth-related operations.
 * - Does not own UI state; callers (e.g., an AuthContext) decide how to store/derive authenticated UI state.
 *
 * Ownership boundaries:
 * - This module is responsible for fetch options (including cookie/session behavior via `credentials`).
 * - Callers own lifecycle concerns (when to call, how to handle loading/errors, and how to store any returned values).
 */
import { API_BASE } from '@/config/apiConfig';

type LoginPayload = {
    user_name: string;
    user_password: string;
};

type LoginSuccess = {
    success: true;
    user_name: string;
};

type LoginError = {
    error: string;
    message?: string;
};

/**
 * Attempts to authenticate a user via the backend.
 *
 * Inputs:
 * - `payload.user_name` / `payload.user_password` are forwarded as-is to the backend; this function does not validate
 *   formats beyond typing.
 *
 * Side effects:
 * - Performs a `POST` request to the auth endpoint.
 * - Sends cookies/receives cookie updates by using `credentials: 'include'`.
 *
 * Output:
 * - Resolves to the parsed JSON response, typed as either `LoginSuccess` or `LoginError`.
 *
 * Error semantics:
 * - Rejects by throwing an `Error` when the HTTP status is non-2xx.
 * - Does not normalize JSON-level errors; any error shape in the successful JSON response is returned to the caller.
 */
export async function loginRequest(
  payload: LoginPayload
): Promise<LoginSuccess | LoginError> {
    const resp = await fetch(`${API_BASE}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
            type: 'login',
            user_name: payload.user_name,
            user_password: payload.user_password,
        }),
    });

  if (!resp.ok) {
    throw new Error(`HTTP error ${resp.status}`);
  }

  return resp.json();
}

  /**
   * Verifies whether the current browser session is authenticated.
   *
   * Side effects:
   * - Performs a `GET` request and includes cookies (`credentials: 'include'`).
   *
   * Output:
   * - Resolves to an object containing `{ loggedIn: boolean }` as returned by the backend.
   *
   * Error semantics:
   * - Rejects by throwing an `Error` when the HTTP status is non-2xx.
   */
export async function verifyRequest() {
    const resp = await fetch(`${API_BASE}/auth/verify-token`, {
        method: 'GET',
        credentials: 'include',
    });

  if (!resp.ok) {
    throw new Error(`HTTP error ${resp.status}`);
  }

  return resp.json() as Promise<{ loggedIn: boolean }>;
}
