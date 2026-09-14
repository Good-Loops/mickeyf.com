/**
 * Frontend authentication state owner.
 *
 * Purpose:
 * - React context that owns in-memory auth state (user + status flags) and exposes it to the app via a provider.
 *
 * Boundary:
 * - Bridges the imperative auth service layer (`authService`) into React state and a stable provider value.
 *
 * Ownership:
 * - This module owns UI-facing auth state and update actions.
 * - The service layer (`services/authService.ts`) owns network/provider calls.
 */
import { createContext, useContext, useState, ReactNode, useEffect, useRef } from 'react';
import { loginRequest, logoutRequest, verifyRequest, renewRequest, deleteAccountRequest, runProviderAuthentication } from '@/services/authService';
import type { DeleteAccountResponse, ProviderAuthenticationInput, AcquireProviderCredential,
    ProviderAuthenticationOptions, ProviderAuthenticationResult } from '@/services/authApi';
import { watchSessionRenewalActivity } from '@/services/sessionRenewalActivity';
import Swal from '@/components/siteAlert';

type LoginOptions = { showFeedback?: boolean; rememberMe?: boolean };

/** UI-facing auth context value owned by `AuthProvider`. */
type AuthContextType = {
    userName: string | null;
    isAuthenticated: boolean;
    loading: boolean;
    login: (user: string, pass: string, options?: LoginOptions) => Promise<boolean>;
    logout: () => Promise<void>;
    deleteAccount: (password: string) => Promise<DeleteAccountResponse>;
    authenticateWithProvider: (input: ProviderAuthenticationInput, acquireCredential: AcquireProviderCredential,
        options?: ProviderAuthenticationOptions) => Promise<ProviderAuthenticationResult>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Provider component that owns auth state and exposes it via context.
 *
 * State:
 * - `userName`: the logged-in user's name, or `null` if not logged in.
 * - `isAuthenticated`: whether the user is currently authenticated.
 * - `loading`: whether the initial auth state is being determined. 
 */
export const AuthProvider = ({ children }: { children: ReactNode }) => {
    const [userName, setUserName] = useState<string | null>(null);
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [loading, setLoading] = useState(true);
    const authActionVersion = useRef(0);
    const sessionMayExist = useRef(true);
    const renewalActivity = useRef<ReturnType<typeof watchSessionRenewalActivity> | null>(null);

    useEffect(() => {
        let active = true;
        const renewSession = async () => {
            const actionVersion = authActionVersion.current;
            const canApply = () => active && actionVersion === authActionVersion.current;
            try {
                const session = await renewRequest();
                // A late renewal must not undo a newer login, logout or deletion.
                if (!canApply()) return true;
                sessionMayExist.current = session.loggedIn;
                setIsAuthenticated(session.loggedIn);
                setUserName(session.loggedIn ? session.user_name : null);
                return true;
            } catch {
                // An outage is not evidence of sign-out. Later activity can retry quietly.
                return !canApply();
            } finally {
                if (canApply()) setLoading(false);
            }
        };
        const activity = watchSessionRenewalActivity({
            windowEvents: window,
            documentEvents: document,
            isVisible: () => document.visibilityState === 'visible',
            canRenew: () => sessionMayExist.current,
            renew: renewSession,
        });
        renewalActivity.current = activity;
        void activity.renewNow();
        return () => {
            active = false;
            activity.stop();
            renewalActivity.current = null;
        };
    }, []);

    /**
     * Attempts login and updates context state on success.
     *
     * Non-obvious behavior: normalizes common failure modes into user-facing alerts and resolves to a boolean success
     * result rather than throwing.
     */
    const login = async (user: string, pass: string, { showFeedback = true, rememberMe = false }: LoginOptions = {}) => {
        const actionVersion = ++authActionVersion.current;
        setLoading(false);
        try {
            const res = await loginRequest({
                user_name: user,
                user_password: pass,
                remember_me: rememberMe,
            });
            // A completed older login must not undo a more recent logout.
            if (actionVersion !== authActionVersion.current) return false;

            if ('error' in res) {
                if (!showFeedback) return false;
                if (res.error === 'AUTH_FAILED') {
                    await Swal.fire({
                        title: 'Authentication failed',
                        text: 'Please check your username and password',
                        icon: 'error',
                    });
                } else {
                    await Swal.fire({
                        title: 'Login failed',
                        text: res.message ?? 'Try again later',
                        icon: 'error',
                    });
                }
                return false;
            }

            setIsAuthenticated(true);
            setUserName(res.user_name);
            sessionMayExist.current = true;
            renewalActivity.current?.resetCooldown();

            if (showFeedback) {
                await Swal.fire({
                    title: 'Welcome back!',
                    icon: 'success',
                });
            }

            return actionVersion === authActionVersion.current;
        } catch (err) {
            if (actionVersion !== authActionVersion.current) return false;
            console.error(err);
            if (showFeedback) {
                await Swal.fire({
                    title: 'Error',
                    text: 'Could not reach the server.',
                    icon: 'error',
                });
            }
            return false;
        }
    };

    const authenticateWithProvider: AuthContextType['authenticateWithProvider'] = async (input, acquireCredential, options) => {
        const actionVersion = ++authActionVersion.current;
        setLoading(false);
        const result = await runProviderAuthentication(input, acquireCredential, options);
        // A canceled dialog cannot undo a completed server request; a newer
        // logout still owns the UI and runs after completion in the same queue.
        if (actionVersion !== authActionVersion.current) return { error: 'CANCELLED' };
        if ('user_name' in result) {
            setIsAuthenticated(true);
            setUserName(result.user_name);
            sessionMayExist.current = true;
            renewalActivity.current?.resetCooldown();
        }
        return result;
    };

    /**
     * Clears local auth state only after the backend confirms sign-out.
     *
     * Side effect: performs a cookie-bearing request (`credentials: 'include'`) so the server can clear the session.
     */
    const logout = async () => {
        const actionVersion = ++authActionVersion.current;
        setLoading(false);
        try {
            await logoutRequest();
        } catch (err) {
            console.error('logout failed', err);
            // A queued login may have succeeded while its older UI result was
            // discarded. Reconcile that session without guessing that logout worked.
            if (actionVersion !== authActionVersion.current) return;
            try {
                const session = await verifyRequest();
                if (actionVersion !== authActionVersion.current) return;
                setIsAuthenticated(session.loggedIn);
                setUserName(session.loggedIn ? session.user_name : null);
                sessionMayExist.current = session.loggedIn;
                renewalActivity.current?.resetCooldown();
            } catch (verificationError) {
                // If the network is still unavailable, preserve the last known UI state.
                console.error('session check after failed logout failed', verificationError);
            }
            if (actionVersion === authActionVersion.current) {
                await Swal.fire({
                    title: 'Sign-out could not be confirmed',
                    text: 'You may still be signed in. Please try signing out again.',
                    icon: 'error',
                });
            }
            return;
        }
        if (actionVersion === authActionVersion.current) {
            setIsAuthenticated(false);
            setUserName(null);
            sessionMayExist.current = false;
        }
    };

    const deleteAccount = async (password: string): Promise<DeleteAccountResponse> => {
        const actionVersion = ++authActionVersion.current;
        const result = await deleteAccountRequest(password);
        // Like logout, deletion is server-first: a rejected/uncertain request
        // must not hide the account or imply that its data has been removed.
        if (actionVersion === authActionVersion.current
            && ('deleted' in result || result.error === 'UNAUTHENTICATED')) {
            setIsAuthenticated(false);
            setUserName(null);
            setLoading(false);
            sessionMayExist.current = false;
        }
        return result;
    };

    return (
        <AuthContext.Provider
            value={{ userName, isAuthenticated, loading, login, logout, deleteAccount, authenticateWithProvider }}
        >
            {children}
        </AuthContext.Provider>
    );
};

/** Custom hook to access auth context value. */
export const useAuth = () => {
    const ctx = useContext(AuthContext);
    if (!ctx) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return ctx;
};
