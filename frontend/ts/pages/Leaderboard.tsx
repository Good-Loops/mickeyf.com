/**
 * Leaderboard hub ("/leaderboards").
 * Lists leaderboard destinations without duplicating game-launch cards from
 * the separate Games page.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    getLeaderboardCatalog,
    type LeaderboardCatalogGame,
} from '@/services/leaderboardService';

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

function getMetricLabel(game: LeaderboardCatalogGame): string {
    return game.primaryMetric === 'completionTimeMs'
        ? game.labels.completionTime ?? 'Completion time'
        : game.labels.score;
}

const Leaderboard: React.FC = () => {
    const [games, setGames] = useState<LeaderboardCatalogGame[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [requestVersion, setRequestVersion] = useState(0);

    useEffect(() => {
        const abortController = new AbortController();

        const loadCatalog = async () => {
            setIsLoading(true);
            setErrorMessage(null);

            try {
                const response = await getLeaderboardCatalog(abortController.signal);
                setGames(response.games);
            } catch (error) {
                if (!isAbortError(error)) {
                    setErrorMessage(
                        error instanceof Error
                            ? error.message
                            : 'The leaderboards could not be loaded.'
                    );
                }
            } finally {
                if (!abortController.signal.aborted) {
                    setIsLoading(false);
                }
            }
        };

        void loadCatalog();
        return () => abortController.abort();
    }, [requestVersion]);

    return (
        <section className="leaderboard" aria-labelledby="leaderboards-title">
            <header className="leaderboard__header">
                <h1 id="leaderboards-title" className="leaderboard__title">
                    Leaderboards
                </h1>
            </header>

            {isLoading && games.length === 0 && (
                <div className="leaderboard__state" role="status" aria-live="polite">
                    Loading leaderboards…
                </div>
            )}

            {errorMessage && (
                <div className="leaderboard__state leaderboard__state--error" role="alert">
                    <h2>Leaderboards unavailable</h2>
                    <p>{errorMessage}</p>
                    <button
                        className="leaderboard__action"
                        type="button"
                        onClick={() => setRequestVersion((version) => version + 1)}
                    >
                        Try again
                    </button>
                </div>
            )}

            {!isLoading && !errorMessage && games.length === 0 && (
                <div className="leaderboard__state" role="status">
                    <h2>No leaderboards yet</h2>
                    <p>Game leaderboards will appear here when they are available.</p>
                </div>
            )}

            {games.length > 0 && (
                <nav className="leaderboard__cards" aria-label="Game leaderboards">
                    {games.map((game) => (
                        <Link
                            className={`leaderboard-card leaderboard-card--${game.gameId}`}
                            key={game.gameId}
                            to={`/leaderboards/${game.gameId}`}
                        >
                            <h2 className="leaderboard-card__title">{game.displayName}</h2>
                            <dl className="leaderboard-card__metadata">
                                <div>
                                    <dt>Metric</dt>
                                    <dd>{getMetricLabel(game)}</dd>
                                </div>
                            </dl>
                            <div className="leaderboard-card__footer">
                                <span aria-hidden="true">View →</span>
                            </div>
                        </Link>
                    ))}
                </nav>
            )}
        </section>
    );
};

export default Leaderboard;
