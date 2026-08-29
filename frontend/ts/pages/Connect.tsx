/**
 * Connect page ("/connect").
 * Links out to external profiles and community destinations.
 */
import React from "react";

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
        </section>
    );
};

export default Connect;
