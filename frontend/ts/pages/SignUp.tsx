/**
 * Sign-up page ("/signup").
 * Creates an account, then signs in through the existing cookie-based login flow.
 */
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Swal from "@/components/siteAlert";
import StaySignedInCheckbox from "@/components/StaySignedInCheckbox";
import { signupRequest } from "@/services/authService";
import { useAuth } from "@/context/AuthContext";
import { signupAndLogin } from "./signupFlow.ts";

const SignUp: React.FC = () => {
    const [userName, setUserName] = useState("");
    const [email, setEmail] = useState("");
    const [userPassword, setUserPassword] = useState("");
    const [rememberMe, setRememberMe] = useState(false);
    const [loading, setLoading] = useState(false);
    const submitting = useRef(false);
    const { login } = useAuth();
    const navigate = useNavigate();

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (submitting.current) return;
        submitting.current = true;
        setLoading(true);

        try {
            const result = await signupAndLogin({
                user_name: userName,
                email,
                user_password: userPassword,
            }, {
                signup: signupRequest,
                login: (user, password, options) => login(user, password, { ...options, showFeedback: false }),
            }, { rememberMe });

            if (result.status === "rejected") {
                switch (result.error) {
                case "INVALID_EMAIL":
                    Swal.fire({ title: "Invalid email", icon: "warning" });
                    break;
                case "INVALID_PASSWORD":
                    Swal.fire({ title: "Invalid password", icon: "warning" });
                    break;
                case "EMPTY_FIELDS":
                    Swal.fire({ title: "Missing required fields", icon: "warning" });
                    break;
                case "DUPLICATE_USER":
                    Swal.fire({
                        title: "Duplicate user",
                        text: "This email or username is already in use",
                        icon: "warning",
                    });
                    break;
                default:
                    Swal.fire({
                        title: "Could not sign up",
                        text: result.message || "Please try again.",
                        icon: "error",
                    });
                    break;
                }
            } else {
                setUserName("");
                setEmail("");
                setUserPassword("");

                if (result.status === "authenticated") {
                    await Swal.fire({
                        title: "You're all set!",
                        text: "Your account is ready and you're logged in. Go break some records!",
                        icon: "success",
                        confirmButtonText: "Let's go",
                    });
                    navigate("/");
                } else {
                    // Registration succeeded: never ask the user to create it again.
                    await Swal.fire({
                        title: "Account created",
                        text: "We couldn't log you in automatically. Please log in with your new account.",
                        icon: "info",
                        confirmButtonText: "Go to log in",
                    });
                    navigate("/login");
                }
            }
        } catch (error) {
            console.error(error);
            Swal.fire({
                title: "Network/server error",
                text: "Could not reach the server.",
                icon: "error",
            });
        } finally {
            submitting.current = false;
            setLoading(false);
        }
    };

    return (
        <section className="signup" aria-labelledby="signup-title">
            <h1 id="signup-title" className="u-visually-hidden">Sign up</h1>
            <div className="signup__form-wrapper">
                <form className="signup__form" onSubmit={handleSubmit} aria-busy={loading}>
                    <label className="signup__field" htmlFor="signup-username">
                        <span className="signup__label">Username</span>
                        <input
                            id="signup-username"
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
                            className="signup__input"
                            type="password"
                            name="user_password"
                            autoComplete="new-password"
                            required
                            value={userPassword}
                            onChange={(inputEvent) => setUserPassword(inputEvent.target.value)}
                        />
                    </label>
                    <StaySignedInCheckbox checked={rememberMe} onChange={setRememberMe} disabled={loading} />
                    <button className="signup__submit" type="submit" disabled={loading}>
                        {loading ? "Signing up…" : "Sign up"}
                    </button>
                </form>
            </div>
        </section>
    );
};

export default SignUp;
