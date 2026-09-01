/**
 * Sign-up page ("/signup").
 * Collects account details and calls the existing backend registration endpoint.
 */
import { useState } from "react";
import Swal from "sweetalert2";
import { API_BASE } from "@/config/apiConfig";

const SignUp: React.FC = () => {
    const [userName, setUserName] = useState("");
    const [email, setEmail] = useState("");
    const [userPassword, setUserPassword] = useState("");
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setLoading(true);

        try {
            const response = await fetch(`${API_BASE}/api/users`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    type: "signup",
                    user_name: userName,
                    email,
                    user_password: userPassword,
                }),
                credentials: "include",
            });

            if (!response.ok) {
                throw new Error(`HTTP error: ${response.status}`);
            }

            const data = await response.json();

            if (data.error) {
                switch (data.error) {
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
                        text: data.message || "Please try again.",
                        icon: "error",
                    });
                    break;
                }
            } else {
                Swal.fire({
                    title: "Welcome, go break some records!",
                    text: "Successfully signed up",
                    icon: "success",
                });
                setUserName("");
                setEmail("");
                setUserPassword("");
            }
        } catch (error) {
            console.error(error);
            Swal.fire({
                title: "Network/server error",
                text: "Could not reach the server.",
                icon: "error",
            });
        } finally {
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
                    <button className="signup__submit" type="submit" disabled={loading}>
                        {loading ? "Signing up…" : "Sign up"}
                    </button>
                </form>
            </div>
        </section>
    );
};

export default SignUp;
