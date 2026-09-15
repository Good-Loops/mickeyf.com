import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { RouteHeading } from '@/components/RouteHeading';
import ProviderSignInControls, { providerSignInErrorMessage } from '@/components/ProviderSignInControls';
import { providerAccountMethodsRequest } from '@/services/authService';
import type { ProviderAccountMethods } from '@/services/authApi';
import { acquireProviderCredential, getAvailableProviderClients, type PublicProviderClient } from '@/services/providerClient';
import Swal from '@/components/siteAlert';
import { useAuth } from '@/context/AuthContext';
import { PUBLIC_API_PREVIEW } from '@/config/apiConfig';
import PublicAccountPreviewNotice from '@/components/PublicAccountPreviewNotice';

export default function ManageAccount() {
    const { userName, isAuthenticated, loading, deleteAccount, authenticateWithProvider } = useAuth();
    const [methods, setMethods] = useState<ProviderAccountMethods | null>(null);
    const [googleClient, setGoogleClient] = useState<PublicProviderClient | undefined>();
    const [methodsLoading, setMethodsLoading] = useState(true);
    const [methodsRetry, setMethodsRetry] = useState(0);
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [busy, setBusy] = useState(false);
    const [providerBusy, setProviderBusy] = useState(false);
    const controlsBusy = busy || providerBusy;
    const [error, setError] = useState('');
    const submitting = useRef(false);
    const navigate = useNavigate();
    const deletionOperation = useRef<AbortController | null>(null);
    const confirmationPopup = useRef<HTMLElement | null>(null);
    const passwordless = methods?.hasPassword === false;
    const deletionReady = !!methods && (methods.hasPassword
        || (methods.googleLinked && methods.googleDeletionEnabled && !!googleClient));

    useEffect(() => {
        if (PUBLIC_API_PREVIEW || loading || !isAuthenticated) return;
        let active = true;
        setMethodsLoading(true);
        setMethods(null);
        void Promise.all([providerAccountMethodsRequest(), getAvailableProviderClients().catch(() => [])])
            .then(([availableMethods, clients]) => {
                if (!active) return;
                setMethods(availableMethods);
                setGoogleClient(clients.find(client => client.clientKey === 'google-web'));
                setMethodsLoading(false);
            });
        return () => { active = false; };
    }, [loading, isAuthenticated, userName, methodsRetry]);

    useEffect(() => () => {
        deletionOperation.current?.abort();
        if (confirmationPopup.current && Swal.getPopup() === confirmationPopup.current) Swal.close();
    }, []);

    const handleDelete = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (PUBLIC_API_PREVIEW || submitting.current || !deletionReady || (!passwordless && !password) || confirmation !== 'DELETE') return;
        submitting.current = true;
        setBusy(true);
        setError('');
        const controller = new AbortController();
        deletionOperation.current = controller;

        try {
            let onConfirmationClosed!: () => void;
            const confirmationClosed = new Promise<void>(resolve => { onConfirmationClosed = resolve; });
            const decision = await Swal.fire({
                title: 'Permanently delete your account?',
                text: 'Your username, account details, personal bests, public leaderboard entries and remaining score-submission receipts will be removed. This cannot be undone.',
                icon: 'warning',
                showCancelButton: true,
                focusCancel: true,
                confirmButtonText: 'Delete permanently',
                cancelButtonText: 'Keep account',
                didOpen: popup => { confirmationPopup.current = popup; },
                didDestroy: onConfirmationClosed,
            });
            // Google needs the alert host only after the destructive confirmation has closed.
            await confirmationClosed;
            confirmationPopup.current = null;
            if (!decision.isConfirmed || controller.signal.aborted) return;

            const result = passwordless && googleClient
                ? await authenticateWithProvider({ action: 'delete', clientKey: googleClient.clientKey, confirmation: 'DELETE' },
                    (challenge, signal) => acquireProviderCredential(googleClient, challenge, signal),
                    { signal: controller.signal })
                : await deleteAccount(password);
            if (controller.signal.aborted) return;
            setPassword('');
            if ('deleted' in result) {
                navigate('/', { replace: true });
                await Swal.fire({
                    title: 'Account deleted',
                    text: 'Your account and scores have been removed. You can still enjoy the games as a guest.',
                    icon: 'success',
                });
                return;
            }
            if (!('error' in result)) { setError('We could not confirm account deletion.'); return; }
            if (result.error === 'UNAUTHENTICATED' || result.error === 'INVALID_CONTEXT' || result.error === 'ACCOUNT_GONE') {
                navigate('/login', { replace: true });
                await Swal.fire({
                    title: 'Please log in again',
                    text: 'Your session is no longer active. We have not confirmed account deletion. Log in and return to Manage account to try again.',
                    icon: 'info',
                });
                return;
            }
            if (passwordless) {
                setError(providerSignInErrorMessage(result.error, 'delete') ?? '');
                return;
            }
            setError(result.error === 'INVALID_PASSWORD'
                ? 'That password did not match. Enter your current password and try again.'
                : result.error === 'INVALID_REQUEST'
                    ? 'Please check the confirmation and enter your current password again.'
                    : result.error === 'RATE_LIMITED'
                        ? 'Too many attempts. Please wait 15 minutes before trying again.'
                    : result.error === 'ACCOUNT_DELETION_PENDING'
                        ? 'Your deletion request was recorded, but completion has not been confirmed. Retrying will not cancel the request. If it remains pending, contact mickeyf.plays@gmail.com.'
                    : 'We could not confirm account deletion. A request may already be recorded; retrying later will not cancel it.');
        } catch {
            // A lost response could follow a successful deletion. Do not claim
            // either outcome, retry automatically, or log password-bearing errors.
            setPassword('');
            setError('We could not confirm account deletion. Your request may already be recorded. Check your connection and try again; this will not cancel a recorded request.');
        } finally {
            deletionOperation.current = null;
            submitting.current = false;
            setBusy(false);
        }
    };

    return (
        <section className="manage-account" aria-labelledby="manage-account-title">
            <div className="manage-account__form-wrapper">
                <RouteHeading id="manage-account-title" className="manage-account__title" focusKey={loading}>
                    Manage account
                </RouteHeading>
                {PUBLIC_API_PREVIEW ? <>
                    <PublicAccountPreviewNotice />
                    {loading ? <p role="status">Checking your session…</p> : isAuthenticated
                        ? <p className="manage-account__identity">Signed in as <strong>{userName}</strong></p>
                        : <p><Link to="/login">Log in</Link> to your public account.</p>}
                    <p>Account linking and deletion are not available on this public backend.
                        For account help, contact <a href="mailto:mickeyf.plays@gmail.com">mickeyf.plays@gmail.com</a>.</p>
                </> : loading ? <p role="status">Checking your session…</p> : !isAuthenticated ? (
                    <p><Link to="/login">Log in</Link> to manage your account. You can keep playing as a guest.</p>
                ) : (
                    <>
                        <p className="manage-account__identity">Signed in as <strong>{userName}</strong></p>
                        {methods?.hasPassword && <ProviderSignInControls action="link" disabled={busy}
                            operationLock={submitting} onBusyChange={setProviderBusy}
                            onSuccess={() => setMethodsRetry(value => value + 1)} />}
                        <h2 className="manage-account__subtitle">Delete account</h2>
                        <p id="deletion-consequences">
                            Permanently remove your username, account details, personal bests,
                            public leaderboard entries and remaining score-submission receipts.
                            This cannot be undone. Guest play remains available.
                        </p>
                        {methodsLoading ? <p role="status">Loading account options…</p> : !methods ? (
                            <div role="alert"><p>Could not load your account options.</p>
                                <button type="button" onClick={() => setMethodsRetry(value => value + 1)}>Try again</button></div>
                        ) : <form className="manage-account__form" onSubmit={handleDelete} aria-busy={controlsBusy} aria-describedby="deletion-consequences">
                            {passwordless ? <p>{deletionReady
                                ? 'After confirming, verify the Google account linked to Ludolume. No password is needed.'
                                : 'Google verification for deletion is unavailable here. Use the Ludolume website when enabled, or contact mickeyf.plays@gmail.com.'}</p> : <label className="manage-account__field" htmlFor="delete-account-password">
                                <span className="manage-account__label">Current password</span>
                                <input
                                    id="delete-account-password"
                                    className="manage-account__input"
                                    type="password"
                                    name="current-password"
                                    autoComplete="current-password"
                                    required
                                    disabled={controlsBusy}
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                />
                            </label>}
                            <label className="manage-account__field" htmlFor="delete-account-confirmation">
                                <span className="manage-account__label">Type DELETE to confirm</span>
                                <input
                                    id="delete-account-confirmation"
                                    className="manage-account__input"
                                    type="text"
                                    autoComplete="off"
                                    autoCapitalize="characters"
                                    spellCheck={false}
                                    pattern="DELETE"
                                    required
                                    disabled={controlsBusy}
                                    value={confirmation}
                                    onChange={(event) => setConfirmation(event.target.value)}
                                />
                            </label>
                            {error && <p className="manage-account__error" role="alert">{error}</p>}
                            <button className="manage-account__submit" type="submit" disabled={controlsBusy || !deletionReady || (!passwordless && !password) || confirmation !== 'DELETE'}>
                                {busy ? 'Please wait…' : passwordless ? 'Verify with Google and delete' : 'Delete account'}
                            </button>
                        </form>}
                    </>
                )}
            </div>
        </section>
    );
}
