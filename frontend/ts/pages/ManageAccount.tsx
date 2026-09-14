import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { RouteHeading } from '@/components/RouteHeading';
import ProviderSignInControls from '@/components/ProviderSignInControls';
import Swal from '@/components/siteAlert';
import { useAuth } from '@/context/AuthContext';

export default function ManageAccount() {
    const { userName, isAuthenticated, loading, deleteAccount } = useAuth();
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [busy, setBusy] = useState(false);
    const [providerBusy, setProviderBusy] = useState(false);
    const controlsBusy = busy || providerBusy;
    const [error, setError] = useState('');
    const submitting = useRef(false);
    const navigate = useNavigate();

    const handleDelete = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (submitting.current || !password || confirmation !== 'DELETE') return;
        submitting.current = true;
        setBusy(true);
        setError('');

        try {
            const decision = await Swal.fire({
                title: 'Permanently delete your account?',
                text: 'Your username, account details, personal bests, public leaderboard entries and remaining score-submission receipts will be removed. This cannot be undone.',
                icon: 'warning',
                showCancelButton: true,
                focusCancel: true,
                confirmButtonText: 'Delete permanently',
                cancelButtonText: 'Keep account',
            });
            if (!decision.isConfirmed) return;

            const result = await deleteAccount(password);
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
            if (result.error === 'UNAUTHENTICATED') {
                navigate('/login', { replace: true });
                await Swal.fire({
                    title: 'Please log in again',
                    text: 'Your session is no longer active. We have not confirmed account deletion. Log in and return to Manage account to try again.',
                    icon: 'info',
                });
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
                {loading ? <p role="status">Checking your session…</p> : !isAuthenticated ? (
                    <p><Link to="/login">Log in</Link> to manage your account. You can keep playing as a guest.</p>
                ) : (
                    <>
                        <p className="manage-account__identity">Signed in as <strong>{userName}</strong></p>
                        <ProviderSignInControls action="link" disabled={busy}
                            operationLock={submitting} onBusyChange={setProviderBusy} />
                        <h2 className="manage-account__subtitle">Delete account</h2>
                        <p id="deletion-consequences">
                            Permanently remove your username, account details, personal bests,
                            public leaderboard entries and remaining score-submission receipts.
                            This cannot be undone. Guest play remains available.
                        </p>
                        <form className="manage-account__form" onSubmit={handleDelete} aria-busy={controlsBusy} aria-describedby="deletion-consequences">
                            <label className="manage-account__field" htmlFor="delete-account-password">
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
                            </label>
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
                            <button className="manage-account__submit" type="submit" disabled={controlsBusy || !password || confirmation !== 'DELETE'}>
                                {busy ? 'Please wait…' : 'Delete account'}
                            </button>
                        </form>
                    </>
                )}
            </div>
        </section>
    );
}
