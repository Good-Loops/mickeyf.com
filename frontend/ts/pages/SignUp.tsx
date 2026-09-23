/**
 * Sign-up page ("/signup").
 * Creates an account, then signs in through the existing cookie-based login flow.
 */
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { showScopedAlert } from "@/components/scopedAlert";
import { usePageLifetime } from "@/hooks/usePageLifetime";
import StaySignedInCheckbox from "@/components/StaySignedInCheckbox";
import ProviderSignInControls from "@/components/ProviderSignInControls";
import { signupRequest } from "@/services/authService";
import { useAuth } from "@/context/AuthContext";
import { signupAndLogin } from "./signupFlow.ts";
import PublicAccountPreviewNotice from '@/components/PublicAccountPreviewNotice';
import { LEGACY_PUBLIC_API_PREVIEW } from '@/config/apiConfig';

const SignUp: React.FC = () => {
    const [userName, setUserName] = useState("");
    const [email, setEmail] = useState("");
    const [userPassword, setUserPassword] = useState("");
    const [rememberMe, setRememberMe] = useState(false);
    const [loading, setLoading] = useState(false);
    const [providerBusy, setProviderBusy] = useState(false);
    const busy = loading || providerBusy;
    const submitting = useRef(false);
    const { login } = useAuth();
    const navigate = useNavigate();
    const pageLifetime = usePageLifetime();
    const showSignupSuccess = async (signal = pageLifetime.current) => {
        if (!signal || signal.aborted) return;
        await showScopedAlert({ title: "You're all set!",
            text: "Your account is ready and you're logged in. Go break some records!",
            icon: "success", confirmButtonText: "Let's go" }, signal);
        if (!signal.aborted) navigate("/");
    };

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        const signal = pageLifetime.current;
        if (!signal || signal.aborted || submitting.current) return;
        submitting.current = true;
        setLoading(true);

        try {
            const result = await signupAndLogin({
                user_name: userName,
                email,
                user_password: userPassword,
            }, {
                signup: signupRequest,
                // Creation may already have reached the server. Only cancel the not-yet-started login.
                login: (user, password, options) => signal.aborted ? Promise.resolve(false)
                    : login(user, password, { ...options, showFeedback: false }),
            }, { rememberMe: !LEGACY_PUBLIC_API_PREVIEW && rememberMe });

            if (signal.aborted) return;

            if (result.status === "rejected") {
                switch (result.error) {
                case "INVALID_EMAIL":
                    await showScopedAlert({ title: "Invalid email", icon: "warning" }, signal);
                    break;
                case "INVALID_PASSWORD":
                    await showScopedAlert({ title: "Invalid password", icon: "warning" }, signal);
                    break;
                case "EMPTY_FIELDS":
                    await showScopedAlert({ title: "Missing required fields", icon: "warning" }, signal);
                    break;
                case "DUPLICATE_USER":
                    await showScopedAlert({
                        title: "Duplicate user",
                        text: "This email or username is already in use",
                        icon: "warning",
                    }, signal);
                    break;
                default:
                    await showScopedAlert({
                        title: "Could not sign up",
                        text: result.message || "Please try again.",
                        icon: "error",
                    }, signal);
                    break;
                }
            } else {
                setUserName("");
                setEmail("");
                setUserPassword("");

                if (result.status === "authenticated") {
                    await showSignupSuccess(signal);
                } else {
                    // Registration succeeded: never ask the user to create it again.
                    await showScopedAlert({
                        title: "Account created",
                        text: "We couldn't log you in automatically. Please log in with your new account.",
                        icon: "info",
                        confirmButtonText: "Go to log in",
                    }, signal);
                    if (!signal.aborted) navigate("/login");
                }
            }
        } catch (error) {
            if (signal.aborted) return;
            console.error(error);
            await showScopedAlert({
                title: "Network/server error",
                text: "Could not reach the server.",
                icon: "error",
            }, signal);
        } finally {
            submitting.current = false;
            if (!signal.aborted) setLoading(false);
        }
    };

    return (
        <section className="signup" aria-labelledby="signup-title">
            <h1 id="signup-title" className="u-visually-hidden">Sign up</h1>
            <div className="signup__form-wrapper">
                <PublicAccountPreviewNotice />
                <form className="signup__form" onSubmit={handleSubmit} aria-busy={busy}>
                    <label className="signup__field" htmlFor="signup-username">
                        <span className="signup__label">Username</span>
                        <input
                            id="signup-username"
                            disabled={busy}
                            className="signup__input"
                            type="text"
                            name="user_name"
                            autoComplete="username"
                            autoCapitalize="none"
                            spellCheck={false}
                            required
                            value={userName}
                            onChange={(inputEvent) => setUserName(inputEvent.target.value)}
                        />
                    </label>
                    <label className="signup__field" htmlFor="signup-email">
                        <span className="signup__label">Email</span>
                        <input
                            id="signup-email"
                            disabled={busy}
                            className="signup__input"
                            type="text"
                            name="email"
                            inputMode="email"
                            autoComplete="email"
                            autoCapitalize="none"
                            spellCheck={false}
                            required
                            value={email}
                            onChange={(inputEvent) => setEmail(inputEvent.target.value)}
                        />
                    </label>
                    <label className="signup__field" htmlFor="signup-password">
                        <span className="signup__label">Password</span>
                        <input
                            id="signup-password"
                            disabled={busy}
                            className="signup__input"
                            type="password"
                            name="user_password"
                            autoComplete="new-password"
                            required
                            value={userPassword}
                            onChange={(inputEvent) => setUserPassword(inputEvent.target.value)}
                        />
                    </label>
                    {!LEGACY_PUBLIC_API_PREVIEW && <StaySignedInCheckbox checked={rememberMe} onChange={setRememberMe} disabled={busy} />}
                    <button className="signup__submit" type="submit" disabled={busy}>
                        {loading ? "Signing up…" : "Sign up"}
                    </button>
                </form>
                {!LEGACY_PUBLIC_API_PREVIEW && <ProviderSignInControls action="signup" userName={userName} rememberMe={rememberMe}
                    disabled={loading} operationLock={submitting} onBusyChange={setProviderBusy}
                    onSuccess={() => { void showSignupSuccess(); }} />}
            </div>
        </section>
    );
};

export default SignUp;
