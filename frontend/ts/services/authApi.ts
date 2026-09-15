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

export type ProviderAuthenticationInput = Readonly<{
    action: 'login' | 'link' | 'signup' | 'delete'; clientKey: string; rememberMe?: boolean; password?: string;
    userName?: string; confirmation?: 'DELETE';
}>;
export type ProviderAuthenticationChallenge = Readonly<{ state: string; nonce: string; expiresInSeconds: number }>;
export type ProviderAuthenticationResult =
    | { success: true; user_name: string }
    | { success: true; linked: true }
    | { success: true; deleted: true }
    | { error: string };
export type AcquireProviderCredential = (challenge: ProviderAuthenticationChallenge, signal: AbortSignal) => Promise<string>;
export type ProviderAuthenticationOptions = Readonly<{ signal?: AbortSignal }>;
declare const preparedProviderLogin: unique symbol;
/** Only the auth API instance that prepared this opaque handle can complete it. */
export type PreparedProviderLogin = Readonly<{ [preparedProviderLogin]: true }>;
export type PrepareProviderLoginResult =
    | { challenge: ProviderAuthenticationChallenge; handle: PreparedProviderLogin }
    | { error: string };
export type CompleteProviderLoginOptions = ProviderAuthenticationOptions & Readonly<{ rememberMe?: boolean; userName?: string }>;
export type CompleteProviderLoginResult = ProviderAuthenticationResult
    | { signupRequired: true; handle: PreparedProviderLogin };
type ProviderCompletionResponse = ProviderAuthenticationResult
    | { signupRequired: true; challenge: ProviderAuthenticationChallenge };
export type ProviderAccountMethods = Readonly<{ hasPassword: boolean; googleLinked: boolean; googleDeletionEnabled: boolean }>;

const PROVIDER_TOKEN_MAX_LENGTH = 16_384;
const PROVIDER_RANDOM_VALUE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const PROVIDER_FAILURE_STATUSES: Readonly<Record<string, number>> = {
    UNAVAILABLE: 503, INVALID_REQUEST: 400, INVALID_CONTEXT: 403, BUSY: 503,
    INVALID_ATTEMPT: 400, INVALID_PROVIDER_TOKEN: 401, NOT_LINKED: 403,
    INVALID_PASSWORD: 403, LINK_CONFLICT: 409, ACCOUNT_GONE: 401, RATE_LIMITED: 429,
    ALREADY_LINKED: 409, DUPLICATE_USER: 409, INVALID_USERNAME: 400, INVALID_EMAIL: 400,
    ACCOUNT_DELETION_UNAVAILABLE: 503, ACCOUNT_DELETION_PENDING: 503,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: string): boolean {
    return Object.keys(value).sort().join(',') === keys;
}

function validProviderInput(input: unknown): input is ProviderAuthenticationInput {
    if (!isRecord(input) || Object.keys(input).some(key => !['action', 'clientKey', 'rememberMe', 'password', 'userName', 'confirmation'].includes(key))
        || typeof input.clientKey !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(input.clientKey)) return false;
    if (input.action === 'delete') return input.clientKey === 'google-web' && input.confirmation === 'DELETE'
        && input.password === undefined && input.rememberMe === undefined && input.userName === undefined;
    if (input.confirmation !== undefined) return false;
    if (input.action === 'signup') return input.clientKey === 'google-web' && validProviderUserName(input.userName)
        && input.password === undefined && (input.rememberMe === undefined || typeof input.rememberMe === 'boolean');
    if (input.userName !== undefined) return false;
    if (input.action === 'login') {
        return input.password === undefined && (input.rememberMe === undefined || typeof input.rememberMe === 'boolean');
    }
    return input.action === 'link' && input.rememberMe === undefined
        && typeof input.password === 'string' && input.password.length > 0 && input.password.length <= 72
        && new TextEncoder().encode(input.password).length <= 72 && !CONTROL_CHARACTERS.test(input.password);
}

function validProviderUserName(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 64
        && !CONTROL_CHARACTERS.test(value);
}

function validProviderOptions(options: unknown): options is ProviderAuthenticationOptions {
    if (!isRecord(options) || Object.keys(options).some(key => key !== 'signal')) return false;
    const signal = options.signal;
    return signal === undefined || (isRecord(signal) && typeof signal.aborted === 'boolean'
        && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function');
}

function validCompletionOptions(options: unknown): options is CompleteProviderLoginOptions {
    return isRecord(options) && Object.keys(options).every(key => key === 'signal' || key === 'rememberMe' || key === 'userName')
        && (options.rememberMe === undefined || typeof options.rememberMe === 'boolean')
        && (options.userName === undefined || validProviderUserName(options.userName))
        && validProviderOptions({ signal: options.signal });
}

function validProviderToken(idToken: unknown): idToken is string {
    return typeof idToken === 'string' && idToken.length <= PROVIDER_TOKEN_MAX_LENGTH
        && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken);
}

function readProviderChallenge(value: unknown): ProviderAuthenticationChallenge | null {
    if (!isRecord(value) || !hasKeys(value, 'expiresInSeconds,nonce,state')
        || typeof value.state !== 'string' || !PROVIDER_RANDOM_VALUE.test(value.state)
        || typeof value.nonce !== 'string' || !PROVIDER_RANDOM_VALUE.test(value.nonce)
        || !Number.isInteger(value.expiresInSeconds) || Number(value.expiresInSeconds) < 1
        || Number(value.expiresInSeconds) > 300) return null;
    return Object.freeze({ state: value.state, nonce: value.nonce, expiresInSeconds: Number(value.expiresInSeconds) });
}

function credentialFailure(error: unknown): { error: string } {
    return { error: isRecord(error) && (error.name === 'AbortError' || error.code === 'CANCELLED')
        ? 'CANCELLED' : 'UNAVAILABLE' };
}

async function acquireProviderToken(challenge: ProviderAuthenticationChallenge, acquireCredential: AcquireProviderCredential,
    deadline: number, signal?: AbortSignal): Promise<{ idToken: string } | { error: string }> {
    const controller = new AbortController();
    let cancellation: string | null = null;
    let cancel!: (reason: string) => void;
    const cancelled = new Promise<{ error: string }>(resolve => {
        cancel = reason => {
            if (cancellation !== null) return;
            cancellation = reason;
            resolve({ error: reason });
            controller.abort();
        };
    });
    const abort = () => cancel('CANCELLED');
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => cancel('INVALID_ATTEMPT'), Math.max(0, deadline - Date.now()));
    try {
        if (signal?.aborted) abort();
        const credential = Promise.resolve().then(async () => {
            if (cancellation !== null) return { error: cancellation };
            try {
                const idToken = await acquireCredential(challenge, controller.signal);
                if (!validProviderToken(idToken)) {
                    return { error: 'INVALID_PROVIDER_TOKEN' };
                }
                return { idToken };
            } catch (error) { return credentialFailure(error); }
        });
        return await Promise.race([credential, cancelled]);
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
    }
}

export function createAuthApi(apiBase: string, fetchRequest: typeof fetch = fetch) {
    let pendingMutation: Promise<void> = Promise.resolve();
    let providerLoginGeneration = 0;
    type PreparedLogin = {
        clientKey: string; state: string; nonce: string; deadline: number;
        action: 'login' | 'signup';
        generation: number; signal?: AbortSignal; used: boolean;
    };
    const preparedLogins = new WeakMap<PreparedProviderLogin, PreparedLogin>();

    function invalidatePreparedLogins(): void {
        providerLoginGeneration++;
    }

    function preparedLoginError(login: PreparedLogin, signal?: AbortSignal): string | null {
        if (login.signal?.aborted || signal?.aborted || login.generation !== providerLoginGeneration) return 'CANCELLED';
        return Date.now() >= login.deadline ? 'INVALID_ATTEMPT' : null;
    }

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

    async function providerAccountMethodsRequest(): Promise<ProviderAccountMethods | null> {
        try {
            const response = await fetchRequest(`${apiBase}/auth/providers/account`, { method: 'GET', credentials: 'include' });
            if (!response.ok) return null;
            const result: unknown = await response.json();
            return isRecord(result) && hasKeys(result, 'googleDeletionEnabled,googleLinked,hasPassword')
                && typeof result.hasPassword === 'boolean' && typeof result.googleLinked === 'boolean'
                && typeof result.googleDeletionEnabled === 'boolean' ? result as ProviderAccountMethods : null;
        } catch { return null; }
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

    async function postProviderOperation(path: 'begin' | 'complete', body: Record<string, unknown>):
        Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
        try {
            const response = await fetchRequest(`${apiBase}/auth/providers/${path}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                credentials: 'include', body: JSON.stringify(body),
            });
            const result: unknown = await response.json();
            if (response.ok) return { ok: true, body: result };
            if (isRecord(result) && hasKeys(result, 'error') && typeof result.error === 'string'
                && Object.prototype.hasOwnProperty.call(PROVIDER_FAILURE_STATUSES, result.error)
                && PROVIDER_FAILURE_STATUSES[result.error] === response.status) {
                return { ok: false, error: result.error };
            }
        } catch { /* Provider payloads and raw transport errors must not escape to UI or logs. */ }
        return { ok: false, error: 'UNAVAILABLE' };
    }

    async function runProviderAuthentication(input: ProviderAuthenticationInput, acquireCredential: AcquireProviderCredential,
        signal?: AbortSignal): Promise<ProviderAuthenticationResult> {
        if (signal?.aborted) return { error: 'CANCELLED' };
        const beginning = await postProviderOperation('begin', { action: input.action, clientKey: input.clientKey });
        if (signal?.aborted) return { error: 'CANCELLED' };
        if (!beginning.ok) return { error: beginning.error };
        const challenge = readProviderChallenge(beginning.body);
        if (!challenge) return { error: 'INVALID_RESPONSE' };
        const deadline = Date.now() + challenge.expiresInSeconds * 1000;
        const credential = await acquireProviderToken(challenge, acquireCredential, deadline, signal);
        if (signal?.aborted) return { error: 'CANCELLED' };
        if ('error' in credential) return credential;
        if (Date.now() >= deadline) return { error: 'INVALID_ATTEMPT' };
        const result = await completeProviderAuthentication(input, challenge.state, credential.idToken);
        return 'signupRequired' in result ? { error: 'UNAVAILABLE' } : result;
    }

    async function completeProviderAuthentication(input: ProviderAuthenticationInput, state: string,
        idToken: string): Promise<ProviderCompletionResponse> {
        // Once complete is sent, await its cookie mutation and verification even
        // if UI cancellation arrives. Cancelling cannot undo a server-side login.
        const completion = await postProviderOperation('complete', {
            action: input.action, clientKey: input.clientKey, state, idToken,
            ...(input.action === 'login' || input.action === 'signup' ? { rememberMe: input.rememberMe === true }
                : input.action === 'link' ? { password: input.password } : { confirmation: 'DELETE' }),
            ...(input.action === 'signup' ? { userName: input.userName } : {}),
        });
        if (!completion.ok) return { error: completion.error };
        const result = completion.body;
        if (input.action === 'login' && input.clientKey === 'google-web' && isRecord(result)
            && hasKeys(result, 'challenge,signupRequired') && result.signupRequired === true) {
            const challenge = readProviderChallenge(result.challenge);
            return challenge ? { signupRequired: true, challenge } : { error: 'INVALID_RESPONSE' };
        }
        if (!isRecord(result) || result.success !== true) return { error: 'INVALID_RESPONSE' };
        if (input.action === 'link') {
            return hasKeys(result, 'linked,success') && result.linked === true
                ? { success: true, linked: true } : { error: 'INVALID_RESPONSE' };
        }
        if (input.action === 'delete') return hasKeys(result, 'deleted,success') && result.deleted === true
            ? { success: true, deleted: true } : { error: 'INVALID_RESPONSE' };
        if (!hasKeys(result, 'success,user_name') || typeof result.user_name !== 'string'
            || result.user_name.length < 1 || result.user_name.length > 255 || CONTROL_CHARACTERS.test(result.user_name)) {
            return { error: 'INVALID_RESPONSE' };
        }
        try {
            const session: unknown = await verifyRequest();
            if (!isRecord(session) || !hasKeys(session, 'loggedIn,user_name')
                || session.loggedIn !== true || session.user_name !== result.user_name) {
                return { error: 'SESSION_NOT_ESTABLISHED' };
            }
        } catch { return { error: 'UNAVAILABLE' }; }
        return { success: true, user_name: result.user_name };
    }

    function prepareProviderLogin(clientKey: string, options: ProviderAuthenticationOptions = {},
        action: 'login' | 'signup' = 'login'): Promise<PrepareProviderLoginResult> {
        if (!validProviderInput({ action: 'login', clientKey }) || !validProviderOptions(options)
            || (action !== 'login' && (action !== 'signup' || clientKey !== 'google-web'))) {
            return Promise.resolve({ error: 'INVALID_REQUEST' });
        }
        const signal = options.signal;
        if (signal?.aborted) return Promise.resolve({ error: 'CANCELLED' });
        const generation = ++providerLoginGeneration;
        return enqueueMutation(async () => {
            if (signal?.aborted || generation !== providerLoginGeneration) return { error: 'CANCELLED' };
            const startedAt = Date.now();
            // Begin changes the cookie too. Even an abandoned render must wait
            // for this response before a password login can use the queue.
            const beginning = await postProviderOperation('begin', { action, clientKey });
            if (signal?.aborted || generation !== providerLoginGeneration) return { error: 'CANCELLED' };
            if (!beginning.ok) return { error: beginning.error };
            const challenge = readProviderChallenge(beginning.body);
            if (!challenge) return { error: 'INVALID_RESPONSE' };
            const deadline = startedAt + challenge.expiresInSeconds * 1000;
            if (Date.now() >= deadline) return { error: 'INVALID_ATTEMPT' };
            const handle = Object.freeze({}) as PreparedProviderLogin;
            preparedLogins.set(handle, { clientKey, action, state: challenge.state, nonce: challenge.nonce,
                deadline, generation, signal, used: false });
            return { challenge, handle };
        });
    }

    function completeProviderLogin(handle: PreparedProviderLogin, idToken: string,
        options: CompleteProviderLoginOptions = {}): Promise<CompleteProviderLoginResult> {
        if (!validCompletionOptions(options)) return Promise.resolve({ error: 'INVALID_REQUEST' });
        const login = isRecord(handle) ? preparedLogins.get(handle) : undefined;
        if (!login || login.used) return Promise.resolve({ error: 'INVALID_ATTEMPT' });
        if (login.action === 'signup' ? !validProviderUserName(options.userName) : options.userName !== undefined) {
            return Promise.resolve({ error: 'INVALID_REQUEST' });
        }
        login.used = true;
        const signal = options.signal;
        const error = preparedLoginError(login, signal);
        if (error) return Promise.resolve({ error });
        if (!validProviderToken(idToken)) return Promise.resolve({ error: 'INVALID_PROVIDER_TOKEN' });
        const rememberMe = options.rememberMe === true;
        const userName = options.userName?.trim();
        return enqueueMutation(async () => {
            const queuedError = preparedLoginError(login, signal);
            if (queuedError) return { error: queuedError };
            const startedAt = Date.now();
            const result = await completeProviderAuthentication({ action: login.action, clientKey: login.clientKey, rememberMe,
                ...(login.action === 'signup' ? { userName } : {}) },
                login.state, idToken);
            if (!('signupRequired' in result)) return result;
            const continuationError = preparedLoginError(login, signal);
            if (continuationError) return { error: continuationError };
            if (result.challenge.nonce !== login.nonce || result.challenge.state === login.state) {
                return { error: 'INVALID_RESPONSE' };
            }
            const deadline = Math.min(login.deadline, startedAt + result.challenge.expiresInSeconds * 1000);
            if (Date.now() >= deadline) return { error: 'INVALID_ATTEMPT' };
            const continuation = Object.freeze({}) as PreparedProviderLogin;
            preparedLogins.set(continuation, { ...login, action: 'signup', state: result.challenge.state, deadline,
                signal: signal ?? login.signal, used: false });
            return { signupRequired: true, handle: continuation };
        });
    }

    return {
        loginRequest: (payload: LoginPayload) => {
            invalidatePreparedLogins();
            const request = { ...payload };
            return enqueueMutation(() => loginRequest(request));
        },
        signupRequest: (payload: SignupPayload) => {
            invalidatePreparedLogins();
            const request = { ...payload };
            return enqueueMutation(() => signupRequest(request));
        },
        verifyRequest,
        providerAccountMethodsRequest,
        renewRequest: () => enqueueMutation(async () => {
            try {
                const result = await renewRequest();
                // Anonymous renewal leaves the provider binding untouched.
                // Authenticated/uncertain renewal may have rotated its cookie.
                if (result.loggedIn) invalidatePreparedLogins();
                return result;
            } catch (error) {
                invalidatePreparedLogins();
                throw error;
            }
        }),
        logoutRequest: () => {
            invalidatePreparedLogins();
            return enqueueMutation(logoutRequest);
        },
        deleteAccountRequest: (password: string) => {
            invalidatePreparedLogins();
            return enqueueMutation(() => deleteAccountRequest(password));
        },
        prepareProviderLogin,
        completeProviderLogin,
        runProviderAuthentication: (input: ProviderAuthenticationInput, acquireCredential: AcquireProviderCredential,
            options: ProviderAuthenticationOptions = {}): Promise<ProviderAuthenticationResult> => {
            if (!validProviderInput(input) || typeof acquireCredential !== 'function' || !validProviderOptions(options)) {
                return Promise.resolve({ error: 'INVALID_REQUEST' });
            }
            const request = { ...input };
            const signal = options.signal;
            invalidatePreparedLogins();
            // Keep the provider dialog in the queue too: another auth mutation
            // would replace or clear the cookie binding the pending challenge.
            return enqueueMutation(() => runProviderAuthentication(request, acquireCredential, signal));
        },
    };
}
