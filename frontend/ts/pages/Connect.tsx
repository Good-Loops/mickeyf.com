/**
 * Connect page ("/connect").
 * Links out to external profiles and community destinations.
 */
import React, { type FormEvent, useState } from "react";

const feedbackEmail = "mickeyf.plays@gmail.com";
const feedbackSubject = "Feedback for mickeyf.com";

const connectLinks = [
    {
        id: "tiktok",
        label: "TikTok",
        href: "https://www.tiktok.com/@mickeyf.plays",
    },
    {
        id: "instagram",
        label: "Instagram",
        href: "https://www.instagram.com/mickeyf.plays/",
    },
    {
        id: "youtube",
        label: "YouTube",
        href: "https://www.youtube.com/@mickeyfplays",
    },
    {
        id: "github",
        label: "GitHub",
        href: "https://github.com/Good-Loops/mickeyf.com",
    },
] as const;

const Connect: React.FC = () => {
    const [feedbackMessage, setFeedbackMessage] = useState("");

    const openFeedbackEmail = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const message = feedbackMessage.trim();
        if (!message) {
            return;
        }

        const mailtoUrl = `mailto:${feedbackEmail}?subject=${encodeURIComponent(feedbackSubject)}&body=${encodeURIComponent(message)}`;
        window.location.assign(mailtoUrl);
    };

    return (
        <section className="connect" aria-labelledby="connect-title">
            <h1 id="connect-title" className="u-visually-hidden">Connect</h1>
            <div className="connect__grid">
                {connectLinks.map(({ id, label, href }) => (
                    <a
                        key={id}
                        className={`showcase-card connect__link connect__link--${id}`}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`${label} (opens in a new tab)`}
                    >
                        <span className="showcase-card__visual connect__visual" aria-hidden="true">
                            <svg viewBox="0 0 24 24">
                                <use href={`/assets/img/social.svg#${id}`} />
                            </svg>
                        </span>
                        <span className="showcase-card__title connect__label">{label}</span>
                    </a>
                ))}
            </div>
            <form className="connect__feedback" onSubmit={openFeedbackEmail}>
                <div className="connect__feedback-heading">
                    <h2>Feedback</h2>
                    <p id="feedback-email-note">
                        Opens your email app with your feedback ready to send.
                    </p>
                </div>
                <label className="u-visually-hidden" htmlFor="feedback-message">
                    Your feedback
                </label>
                <textarea
                    id="feedback-message"
                    className="connect__feedback-message"
                    value={feedbackMessage}
                    onChange={(event) => setFeedbackMessage(event.target.value)}
                    placeholder="Share an idea, report a problem, or say hello."
                    maxLength={1500}
                    rows={4}
                    required
                    aria-describedby="feedback-email-note"
                />
                <button className="connect__feedback-submit" type="submit">
                    Open email
                </button>
            </form>
        </section>
    );
};

export default Connect;
