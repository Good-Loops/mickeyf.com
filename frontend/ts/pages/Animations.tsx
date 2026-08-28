/**
 * Animations index page ("/animations").
 * Provides navigation to interactive animation experiences.
 */
import React from "react";
import { Link } from "react-router-dom";

const Animations: React.FC = () => {
    return (
        <section className="animations">
            <h1 className="u-visually-hidden">Animations</h1>
            <div className="showcase-grid">
                <Link
                    className="showcase-card animations__card animations__card--circles"
                    to="/animations/dancing-circles"
                >
                    <span
                        className="showcase-card__visual animations__visual"
                        aria-hidden="true"
                    />
                    <h2 className="showcase-card__title">Dancing Circles</h2>
                </Link>
                <Link
                    className="showcase-card animations__card animations__card--fractals"
                    to="/animations/dancing-fractals"
                >
                    <span
                        className="showcase-card__visual animations__visual"
                        aria-hidden="true"
                    />
                    <h2 className="showcase-card__title">Dancing Fractals</h2>
                </Link>
            </div>
        </section>
    );
};

export default Animations;
