/**
 * Games index page ("/games").
 * Provides navigation to interactive game experiences.
 */
import React from "react";
import { Link } from "react-router-dom";
import {
    isThreeBossesLocalEnabled,
    THREE_BOSSES_LOCAL_ROUTE,
} from '@/config/featureFlags';

const Games: React.FC = () => {
    return (
        <section className="games">
            <h1 className="games__title">Games</h1>
            <div className="games__grid">
                <div className="games__grid-item">
                    <Link to="/games/p4-Vega">
                        <h3 className="games__grid-item--p4 floating">p4-Vega</h3>
                    </Link>
                </div>
                {isThreeBossesLocalEnabled && (
                    <div className="games__grid-item">
                        <Link to={THREE_BOSSES_LOCAL_ROUTE}>
                            <h3 className="games__grid-item--three-bosses floating">
                                Three Bosses
                            </h3>
                        </Link>
                    </div>
                )}
            </div>
        </section>
    );
}

export default Games;
