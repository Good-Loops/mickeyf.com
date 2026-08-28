/**
 * Animations index page ("/animations").
 * Provides navigation to interactive animation experiences.
 */
import React from "react";
import { Link } from "react-router-dom";

const Animations: React.FC = () => {
    return (
        <section className="animations">
            <h1 className="animations__title">Animations</h1>
            <div className="animations__grid">
                <Link
                    className="animations__card animations__card--circles"
                    to="/animations/dancing-circles"
                >
                    <span className="animations__visual" aria-hidden="true" />
                    <h2 className="animations__card-title">Dancing Circles</h2>
                </Link>
                <Link
                    className="animations__card animations__card--fractals"
                    to="/animations/dancing-fractals"
                >
                    <span className="animations__visual" aria-hidden="true" />
                    <h2 className="animations__card-title">Dancing Fractals</h2>
                </Link>
            </div>
        </section>
    );
};

export default Animations;
