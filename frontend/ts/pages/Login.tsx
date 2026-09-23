/**
 * Login page ("/login").
 * Collects credentials and delegates authentication to `AuthContext`.
 */
import React, { useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useNavigate } from 'react-router-dom';
import StaySignedInCheckbox from '@/components/StaySignedInCheckbox';
import ProviderSignInControls from '@/components/ProviderSignInControls';
import PublicAccountPreviewNotice from '@/components/PublicAccountPreviewNotice';
import { LEGACY_PUBLIC_API_PREVIEW } from '@/config/apiConfig';
import { usePageLifetime } from '@/hooks/usePageLifetime';

const Login: React.FC = () => {
    const [userName, setUserName] = useState('');
    const [userPassword, setUserPassword] = useState('');
    const [rememberMe, setRememberMe] = useState(false);
    const [loading, setLoading] = useState(false);
    const [providerBusy, setProviderBusy] = useState(false);
    const operationBusy = useRef(false);
    const busy = loading || providerBusy;
    const { login } = useAuth();
    const navigate = useNavigate();
    const pageLifetime = usePageLifetime();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const signal = pageLifetime.current;
        if (!signal || signal.aborted || operationBusy.current) return;
        operationBusy.current = true;
        setLoading(true);

        try {
            const ok = await login(userName, userPassword, {
                rememberMe: !LEGACY_PUBLIC_API_PREVIEW && rememberMe,
                feedbackSignal: signal,
            });
            if (ok && !signal.aborted) navigate('/');
        } finally {
            if (!signal.aborted) setLoading(false);
            operationBusy.current = false;
        }
    };

    return (
        <section className="login" aria-labelledby="login-title">
            <h1 id="login-title" className="u-visually-hidden">Log in</h1>
            <div className="login__form-wrapper">
                <PublicAccountPreviewNotice />
                <form className="login__form" onSubmit={handleSubmit} aria-busy={busy}>
                    <label className="login__field" htmlFor="login-username">
                        <span className="login__label">Username</span>
                        <input
                            id="login-username"
                            className="login__input"
                            type="text"
                            name="user_name"
                            autoComplete="username"
                            autoCapitalize="none"
                            spellCheck={false}
                            required
                            disabled={busy}
                            value={userName}
                            onChange={(event) => setUserName(event.target.value)}
                        />
                    </label>
                    <label className="login__field" htmlFor="login-password">
                        <span className="login__label">Password</span>
                        <input
                            id="login-password"
                            className="login__input"
                            type="password"
                            name="user_password"
                            autoComplete="current-password"
                            required
                            disabled={busy}
                            value={userPassword}
                            onChange={(event) => setUserPassword(event.target.value)}
                        />
                    </label>
                    {!LEGACY_PUBLIC_API_PREVIEW && <StaySignedInCheckbox checked={rememberMe} onChange={setRememberMe} disabled={busy} />}
                    <button className="login__submit" type="submit" disabled={busy}>
                        {loading ? 'Logging in…' : 'Log in'}
                    </button>
                </form>
                {!LEGACY_PUBLIC_API_PREVIEW && <ProviderSignInControls action="login" rememberMe={rememberMe} disabled={loading}
                    operationLock={operationBusy} onBusyChange={setProviderBusy}
                    onSuccess={() => { if (pageLifetime.current && !pageLifetime.current.aborted) navigate('/'); }} />}
            </div>
        </section>
    );
};

export default Login;
