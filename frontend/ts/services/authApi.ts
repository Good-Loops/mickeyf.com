/** Auth HTTP transport, independent of React and environment configuration. */
type AccountCredentials = {
    user_name: string;
    user_password: string;
};

type LoginPayload = AccountCredentials & { remember_me?: boolean };
export type SignupPayload = AccountCredentials & { email: string };
type AccountError = { error: string; message?: string; status?: number };
type LoginResponse = { success: true; user_name: string } | AccountError;
export type SignupResponse = { success: true; error?: never } | AccountError;
export type DeleteAccountResponse =
    | { deleted: true }
    | { error: 'INVALID_REQUEST' | 'INVALID_PASSWORD' | 'UNAUTHENTICATED' | 'ACCOUNT_DELETION_UNAVAILABLE' | 'ACCOUNT_DELETION_PENDING' | 'RATE_LIMITED' };
export type VerificationResponse =
    | { loggedIn: true; user_name: string }
    | { loggedIn: false };
type UserOperation =
    | ({ type: 'login' } & LoginPayload)
    | ({ type: 'signup' } & SignupPayload);

export function createAuthApi(apiBase: string, fetchRequest: typeof fetch = fetch) {
    let pendingMutation: Promise<void> = Promise.resolve();

    function enqueueMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
        // Set-Cookie takes effect before React sees a response. Serialize the
        // transport itself so a late login cannot recreate a logged-out session.
        const result = pendingMutation.then(operation);
        pendingMutation = result.then(() => undefined, () => undefined);
        return result;
    }

    async function postUserOperation(body: UserOperation): Promise<Response> {
        const response = await fetchRequest(`${apiBase}/api/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const separator = body.type === 'signup' ? ':' : '';
            throw new Error(`HTTP error${separator} ${response.status}`);
        }
        // This legacy endpoint returns normal validation errors inside HTTP 200.
        // Callers retain ownership of those alerts; HTTP failures still reject.
        return response;
    }

    async function loginRequest(payload: LoginPayload): Promise<LoginResponse> {
        const response = await postUserOperation({
            type: 'login',
            user_name: payload.user_name,
            user_password: payload.user_password,
            remember_me: payload.remember_me === true,
        });
        const result: LoginResponse = await response.json();
        if ('error' in result) return result;

        // Accepting a password does not prove the client retained its cookie.
        // Confirm the next request authenticates before showing login success.
        const session = await verifyRequest();
        if (!session.loggedIn || session.user_name !== result.user_name) {
            return {
                error: 'SESSION_NOT_ESTABLISHED',
                message: 'Your password was accepted, but the login session could not be saved. Please try again.',
            };
        }
        return result;
    }

    async function signupRequest(payload: SignupPayload): Promise<SignupResponse> {
        const response = await postUserOperation({
            type: 'signup',
            user_name: payload.user_name,
            email: payload.email,
            user_password: payload.user_password,
        });
        return response.json();
    }

    async function verifyRequest(): Promise<VerificationResponse> {
        const response = await fetchRequest(`${apiBase}/auth/verify-token`, {
            method: 'GET',
            credentials: 'include',
        });
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }
        return response.json();
    }

    async function renewRequest(): Promise<VerificationResponse> {
        const response = await fetchRequest(`${apiBase}/auth/renew`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({}),
        });
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);

        const result: unknown = await response.json();
        if (result && typeof result === 'object' && 'loggedIn' in result) {
            if (result.loggedIn === false && Object.keys(result).length === 1) return { loggedIn: false };
            if (result.loggedIn === true && 'user_name' in result
                && typeof result.user_name === 'string' && result.user_name.length > 0
                && Object.keys(result).length === 2) {
                return { loggedIn: true, user_name: result.user_name };
            }
        }
        throw new Error('Could not confirm the renewed session.');
    }

    async function logoutRequest(): Promise<void> {
        const response = await fetchRequest(`${apiBase}/auth/logout`, {
            method: 'POST',
            credentials: 'include',
        });
        if (!response.ok) throw new Error('Could not confirm sign-out.');

        const result: unknown = await response.json();
        if (!result || typeof result !== 'object'
            || !('loggedOut' in result) || result.loggedOut !== true
            || Object.keys(result).length !== 1) {
            throw new Error('Could not confirm sign-out.');
        }
    }

    async function deleteAccountRequest(password: string): Promise<DeleteAccountResponse> {
        const response = await fetchRequest(`${apiBase}/auth/delete-account`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ password, confirmation: 'DELETE' }),
        });
        if (response.status === 401) return { error: 'UNAUTHENTICATED' };

        const result: unknown = await response.json();
        if (result && typeof result === 'object') {
            if (response.status === 200 && 'deleted' in result && result.deleted === true && !('error' in result)) {
                return { deleted: true };
            }
            if ('error' in result) {
                if (response.status === 400 && result.error === 'INVALID_REQUEST') return { error: result.error };
                if (response.status === 403 && result.error === 'INVALID_PASSWORD') return { error: result.error };
                if (response.status === 503 && result.error === 'ACCOUNT_DELETION_UNAVAILABLE') return { error: result.error };
                if (response.status === 503 && result.error === 'ACCOUNT_DELETION_PENDING') return { error: result.error };
                if (response.status === 429 && result.error === 'RATE_LIMITED') return { error: result.error };
            }
        }
        // An empty, malformed or unexpected response is not proof of deletion.
        throw new Error('Could not confirm account deletion.');
    }

    return {
        loginRequest: (payload: LoginPayload) => {
            const request = { ...payload };
            return enqueueMutation(() => loginRequest(request));
        },
        signupRequest: (payload: SignupPayload) => {
            const request = { ...payload };
            return enqueueMutation(() => signupRequest(request));
        },
        verifyRequest,
        renewRequest: () => enqueueMutation(renewRequest),
        logoutRequest: () => enqueueMutation(logoutRequest),
        deleteAccountRequest: (password: string) => enqueueMutation(() => deleteAccountRequest(password)),
    };
}
