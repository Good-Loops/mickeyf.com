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
import { loginRequest, logoutRequest, verifyRequest, deleteAccountRequest } from '@/services/authService';
import type { DeleteAccountResponse } from '@/services/authApi';
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

    useEffect(() => {
        let active = true;
        // A slow startup check must not overwrite a newer login or logout.
        const canApplyVerification = () => active && authActionVersion.current === 0;
        (async () => {
            try {
                const res = await verifyRequest();
                if (!canApplyVerification()) return;
                if (res.loggedIn) {
                    setIsAuthenticated(true);
                    setUserName(res.user_name ?? null);
                } else {
                    setIsAuthenticated(false);
                    setUserName(null);
                }
            } catch (err) {
                if (canApplyVerification()) console.error('verify on mount failed', err);
            } finally {
                if (canApplyVerification()) setLoading(false);
            }
        })();
        return () => { active = false; };
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
        }
        return result;
    };

    return (
        <AuthContext.Provider
            value={{ userName, isAuthenticated, loading, login, logout, deleteAccount }}
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
