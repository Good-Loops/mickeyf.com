import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { RouteHeading } from '@/components/RouteHeading';
import ProviderSignInControls, { providerSignInErrorMessage } from '@/components/ProviderSignInControls';
import { providerAccountMethodsRequest } from '@/services/authService';
import type { ProviderAccountMethods } from '@/services/authApi';
import { acquireProviderCredential, getAvailableProviderClients, selectProviderDeletionClient, type PublicProviderClient } from '@/services/providerClient';
import Swal from '@/components/siteAlert';
import { useAuth } from '@/context/AuthContext';
import { LEGACY_PUBLIC_API_PREVIEW } from '@/config/apiConfig';
import ScoreParticipation from '@/components/ScoreParticipation';
import PublicAccountPreviewNotice from '@/components/PublicAccountPreviewNotice';
import PageStatus from '@/components/PageStatus';

export default function ManageAccount() {
    const { userName, isAuthenticated, loading, sessionGeneration, deleteAccount, authenticateWithProvider, captureAccountAction, captureSessionGeneration } = useAuth();
    const [methods, setMethods] = useState<ProviderAccountMethods | null>(null);
    const [deletionClient, setDeletionClient] = useState<PublicProviderClient | undefined>();
    const [methodsLoading, setMethodsLoading] = useState(true);
    const [methodsRetry, setMethodsRetry] = useState(0);
    const [providersReady, setProvidersReady] = useState(false);
    const [scoresReady, setScoresReady] = useState(false);
    const [linkFeedback, setLinkFeedback] = useState('');
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
    const deletionReady = !!methods && (methods.hasPassword || !!deletionClient);
    const deletionProviderName = deletionClient?.provider === 'apple' ? 'Apple' : 'Google';
    const markProvidersReady = useCallback(() => setProvidersReady(true), []);
    const markScoresReady = useCallback(() => setScoresReady(true), []);
    const pageLoading = !LEGACY_PUBLIC_API_PREVIEW && (loading || isAuthenticated && (methodsLoading || !scoresReady
        || !!(methods?.hasPassword && methods.providerCollectionAllowed === true && !providersReady)));

    useEffect(() => { setProvidersReady(false); setScoresReady(false); setLinkFeedback(''); }, [userName, sessionGeneration]);

    useEffect(() => {
        if (LEGACY_PUBLIC_API_PREVIEW || loading || !isAuthenticated) return;
        let active = true;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        setMethodsLoading(true);
        setMethods(null);
        setDeletionClient(undefined);
        void providerAccountMethodsRequest(controller.signal).then(async availableMethods => {
                const clients = !availableMethods || availableMethods.providerCollectionAllowed === false ? [] : await getAvailableProviderClients().catch(() => []);
                if (!active) return;
                setMethods(availableMethods);
                setDeletionClient(selectProviderDeletionClient(clients, availableMethods));
                setMethodsLoading(false);
            }).catch(() => {
                if (active) setMethodsLoading(false);
            }).finally(() => clearTimeout(timeout));
        return () => { active = false; controller.abort(); clearTimeout(timeout); };
    }, [loading, isAuthenticated, userName, methodsRetry]);

    useEffect(() => () => {
        deletionOperation.current?.abort();
        if (confirmationPopup.current && Swal.getPopup() === confirmationPopup.current) Swal.close();
    }, []);

    const handleDelete = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (LEGACY_PUBLIC_API_PREVIEW || submitting.current || !deletionReady || (!passwordless && !password) || confirmation !== 'DELETE') return;
        submitting.current = true;
        setBusy(true);
        setError('');
        const controller = new AbortController();
        const pagePath = typeof window === 'undefined' ? null : window.location.pathname;
        const isCurrent = () => (typeof window === 'undefined' ? null : window.location.pathname) === pagePath;
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
            // Provider presentation starts only after the destructive confirmation has closed.
            await confirmationClosed;
            confirmationPopup.current = null;
            if (!decision.isConfirmed || controller.signal.aborted || !isCurrent()) return;

            const result = passwordless && deletionClient
                ? await authenticateWithProvider({ action: 'delete', clientKey: deletionClient.clientKey, confirmation: 'DELETE' },
                    (challenge, signal) => acquireProviderCredential(deletionClient, challenge, signal),
                    { signal: controller.signal, isCurrent })
                : await deleteAccount(password);
            if (controller.signal.aborted || !isCurrent()) return;
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
                setError(providerSignInErrorMessage(result.error, 'delete', deletionClient?.provider) ?? '');
                return;
            }
            setError(result.error === 'INVALID_PASSWORD'
                ? 'That password did not match. Enter your current password and try again.'
                : result.error === 'INVALID_REQUEST'
                    ? 'Please check the confirmation and enter your current password again.'
                    : result.error === 'RATE_LIMITED'
                        ? 'Too many attempts. Please wait 15 minutes before trying again.'
                    : result.error === 'ACCOUNT_DELETION_PENDING'
                        ? 'Your deletion request may have been recorded, but completion has not been confirmed. Retrying will not cancel the request. Contact mickeyf.plays@gmail.com if you need help.'
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

    return (<>
        {pageLoading && <PageStatus variant="loading" />}
        <section hidden={pageLoading} style={pageLoading ? { display: 'none' } : undefined} className="manage-account" aria-labelledby="manage-account-title">
            <div className="manage-account__form-wrapper">
                <RouteHeading id="manage-account-title" className="manage-account__title" focusKey={pageLoading}>
                    Manage account
                </RouteHeading>
                <PublicAccountPreviewNotice />
                {LEGACY_PUBLIC_API_PREVIEW ? <>
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
                        <p className="manage-account__family"><Link to="/parent-accounts">Manage parent and child accounts</Link></p>
                        {methods && (methods.googleLinked || methods.appleLinked) && <p role="status">
                            Linked sign-in: {[methods.googleLinked && 'Google', methods.appleLinked && 'Apple'].filter(Boolean).join(', ')}
                        </p>}
                        {linkFeedback && <p role="status">{linkFeedback}</p>}
                        {methods?.hasPassword && methods.providerCollectionAllowed === true && <ProviderSignInControls action="link" disabled={busy}
                            operationLock={submitting} onReady={markProvidersReady} onBusyChange={value => { setProviderBusy(value); if (value) setLinkFeedback(''); }}
                            onSuccess={provider => { if (provider) setLinkFeedback(`${provider === 'google' ? 'Google' : 'Apple'} account linked successfully.`); setProvidersReady(false); setMethodsRetry(value => value + 1); }} />}
                        <ScoreParticipation authenticated={isAuthenticated} accountKey={userName ?? ''} sessionGeneration={sessionGeneration}
                            captureAccountAction={captureAccountAction} captureSessionGeneration={captureSessionGeneration} onReady={markScoresReady} />
                        <section className="manage-account__danger" aria-labelledby="delete-account-heading">
                            <h2 id="delete-account-heading" className="manage-account__subtitle">Delete account</h2>
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
                                    ? `After confirming, verify the ${deletionProviderName} account linked to Ludolume. No password is needed.`
                                    : 'Provider verification for deletion is unavailable here. Contact mickeyf.plays@gmail.com for account help.'}</p> : <label className="manage-account__field" htmlFor="delete-account-password">
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
                                    {busy ? 'Please wait…' : passwordless && deletionClient ? `Verify with ${deletionProviderName} and delete` : 'Delete account'}
                                </button>
                            </form>}
                        </section>
                    </>
                )}
            </div>
        </section>
    </>);
}
