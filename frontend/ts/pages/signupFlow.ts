import type { SignupPayload, SignupResponse } from '../services/authApi.ts';

type SignupDependencies = {
    signup: (payload: SignupPayload) => Promise<SignupResponse>;
    login: (userName: string, password: string, options: { rememberMe: boolean }) => Promise<boolean>;
};

type SignupResult =
    | { status: 'rejected'; error: string; message?: string }
    | { status: 'authenticated' }
    | { status: 'login-required' };

export async function signupAndLogin(
    payload: SignupPayload,
    { signup, login }: SignupDependencies,
    { rememberMe = false }: { rememberMe?: boolean } = {},
): Promise<SignupResult> {
    const response = await signup(payload);
    if (response && typeof response === 'object' && 'error' in response && response.error) {
        return { status: 'rejected', error: response.error, message: response.message };
    }
    if (!response || typeof response !== 'object' || !('success' in response) || response.success !== true) {
        throw new Error('Unexpected signup response');
    }

    // The account already exists: a failed login must not invite another signup.
    try {
        const authenticated = await login(payload.user_name, payload.user_password, { rememberMe });
        return { status: authenticated ? 'authenticated' : 'login-required' };
    } catch {
        return { status: 'login-required' };
    }
}
