/**
 * Leaderboard hub ("/leaderboards").
 * Lists leaderboard destinations without duplicating game-launch cards from
 * the separate Games page.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RouteHeading } from '@/components/RouteHeading';
import {
    getLeaderboardCatalog,
    type LeaderboardCatalogGame,
    type LeaderboardCatalogResponse,
} from '@/services/leaderboardService';

type LeaderboardCatalogReader = (
    signal?: AbortSignal
) => Promise<LeaderboardCatalogResponse>;

export async function loadLeaderboardCatalogGames(
    signal?: AbortSignal,
    readCatalog: LeaderboardCatalogReader = getLeaderboardCatalog
): Promise<LeaderboardCatalogGame[]> {
    return (await readCatalog(signal)).games;
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

function getMetricLabel(game: LeaderboardCatalogGame): string {
    return game.primaryMetric === 'completionTimeMs'
        ? game.labels.completionTime ?? 'Completion time'
        : game.labels.score;
}

type LeaderboardViewProps = {
    games: LeaderboardCatalogGame[];
    isLoading: boolean;
    errorMessage: string | null;
    onRetry: () => void;
};

export function LeaderboardView({
    games,
    isLoading,
    errorMessage,
    onRetry,
}: LeaderboardViewProps) {
    return (
        <section className="leaderboard leaderboard--hub" aria-labelledby="leaderboards-title">
            <RouteHeading id="leaderboards-title" className="u-visually-hidden">
                Leaderboards
            </RouteHeading>

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
                        onClick={onRetry}
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
                <nav className="leaderboard__cards showcase-grid" aria-label="Game leaderboards">
                    {games.map((game) => (
                        <Link
                            className={`showcase-card leaderboard-card leaderboard-card--${game.gameId}`}
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
                setGames(await loadLeaderboardCatalogGames(abortController.signal));
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
        <LeaderboardView
            games={games}
            isLoading={isLoading}
            errorMessage={errorMessage}
            onRetry={() => setRequestVersion((version) => version + 1)}
        />
    );
};

export default Leaderboard;
