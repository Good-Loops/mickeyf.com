/**
 * Games index page ("/games").
 * Provides navigation to interactive game experiences.
 */
import React from "react";
import { Link } from "react-router-dom";
import {
    isThreeBossesLocalEnabled,
    THREE_BOSSES_LOCAL_ROUTE,
} from "@/config/featureFlags";

const Games: React.FC = () => {
    return (
        <section className="games">
            <h1 className="u-visually-hidden">Games</h1>
            <div className="showcase-grid">
                <Link
                    className="showcase-card games__card games__card--p4"
                    to="/games/p4-Vega"
                >
                    <span
                        className="showcase-card__visual games__visual"
                        aria-hidden="true"
                    />
                    <h2 className="showcase-card__title">p4-Vega</h2>
                </Link>
                {isThreeBossesLocalEnabled && (
                    <Link
                        className="showcase-card games__card games__card--three-bosses"
                        to={THREE_BOSSES_LOCAL_ROUTE}
                    >
                        <span
                            className="showcase-card__visual games__visual"
                            aria-hidden="true"
                        />
                        <h2 className="showcase-card__title">Three Bosses</h2>
                    </Link>
                )}
            </div>
        </section>
    );
};

export default Games;
