/**
 * Login page ("/login").
 * Collects credentials and delegates authentication to `AuthContext`.
 */
import React, { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useNavigate } from 'react-router-dom';

const Login: React.FC = () => {
    const [userName, setUserName] = useState('');
    const [userPassword, setUserPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const { login } = useAuth();
    const navigate = useNavigate();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (loading) return;
        setLoading(true);

        const ok = await login(userName, userPassword);

        setLoading(false);

        if (ok) {
            navigate('/');
        }
    };

    return (
        <section className="login" aria-labelledby="login-title">
            <h1 id="login-title" className="u-visually-hidden">Log in</h1>
            <div className="login__form-wrapper">
                <form className="login__form" onSubmit={handleSubmit} aria-busy={loading}>
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
                            value={userPassword}
                            onChange={(event) => setUserPassword(event.target.value)}
                        />
                    </label>
                    <button className="login__submit" type="submit" disabled={loading}>
                        {loading ? 'Logging in…' : 'Log in'}
                    </button>
                </form>
            </div>
        </section>
    );
};

export default Login;
