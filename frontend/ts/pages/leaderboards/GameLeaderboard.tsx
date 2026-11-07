/** Direct-linkable leaderboard detail page for one server-catalog game. */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { RouteHeading } from '@/components/RouteHeading';
import {
    getGameLeaderboard,
    getLeaderboardCatalog,
    leaderboardSourceNotice,
    type GameLeaderboardResponse,
    type LeaderboardCatalogGame,
} from '@/services/leaderboardDisplayService';
import {
    isAbortError,
    loadGameLeaderboardState,
    type DetailState,
} from './leaderboardDetailState';

const numberFormatter = new Intl.NumberFormat('en-US');

function formatCompletionTime(milliseconds: number): string {
    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
    const seconds = Math.floor((milliseconds % 60_000) / 1_000);
    const remainder = milliseconds % 1_000;
    const preciseSeconds = `${seconds.toString().padStart(2, '0')}.${remainder
        .toString()
        .padStart(3, '0')}`;

    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${preciseSeconds}`;
    }

    if (minutes > 0) {
        return `${minutes}:${preciseSeconds}`;
    }

    return `${seconds}.${remainder.toString().padStart(3, '0')}s`;
}

function getEmptyMessage(game: LeaderboardCatalogGame): string {
    if (game.submissionState === 'disabled') {
        return `${game.displayName} score submission is not open yet.`;
    }

    return 'No results have been recorded for this leaderboard yet.';
}

function LeaderboardTable({
    game,
    leaderboard,
}: {
    game: LeaderboardCatalogGame;
    leaderboard: GameLeaderboardResponse;
}) {
    if (leaderboard.entries.length === 0) {
        return (
            <div className="leaderboard__state leaderboard__state--empty" role="status">
                <h2>No results yet</h2>
                <p>{getEmptyMessage(game)}</p>
            </div>
        );
    }

    const timedLeaderboard = leaderboard.gameId === 'three-bosses';
    return (
        <div
            className="leaderboard__table-wrapper"
            role="region"
            aria-label={`${game.displayName} leaderboard results`}
            tabIndex={0}
        >
            <table className="leaderboard__table">
                <caption>{game.displayName} {timedLeaderboard ? 'top completion times' : 'top scores'}</caption>
                <thead>
                    <tr>
                        <th scope="col" className="leaderboard__position">
                            <span aria-hidden="true">#</span><span className="u-visually-hidden">Position</span>
                        </th>
                        <th scope="col" className="leaderboard__player">Player</th>
                        <th scope="col" className="leaderboard__primary">
                            {timedLeaderboard ? game.labels.completionTime ?? 'Time' : game.labels.score}
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {leaderboard.entries.map((entry) => {
                        const timedEntry = 'completionTimeMs' in entry ? entry : null;
                        return (
                            <tr key={entry.position}>
                                <td className="leaderboard__position">
                                    <span className="leaderboard__position-badge">{entry.position}</span>
                                </td>
                                <td className="leaderboard__player">
                                    <span className="leaderboard__player-name">{entry.userName}</span>
                                    {timedEntry && (
                                        <dl className="leaderboard__secondary">
                                            <div><dt>{game.labels.score}</dt><dd>{numberFormatter.format(entry.score)}</dd></div>
                                            <div><dt>{game.labels.rank ?? 'Rank'}</dt><dd>{timedEntry.rank}</dd></div>
                                        </dl>
                                    )}
                                </td>
                                <td className="leaderboard__primary">
                                    <strong className="leaderboard__result-value">
                                        {timedEntry ? formatCompletionTime(timedEntry.completionTimeMs) : numberFormatter.format(entry.score)}
                                    </strong>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

type GameLeaderboardViewProps = {
    gameId: string | undefined;
    state: DetailState;
    onRetry: () => void;
};

export function GameLeaderboardView({
    gameId,
    state,
    onRetry,
}: GameLeaderboardViewProps) {
    const headingFocusKey = `${gameId ?? 'unknown'}:${state.status}`;

    if (state.status === 'loading') {
        return (
            <section
                className="leaderboard leaderboard--detail"
                aria-labelledby="leaderboard-loading-title"
            >
                <div className="leaderboard__state" role="status" aria-live="polite">
                    <RouteHeading
                        id="leaderboard-loading-title"
                        focusKey={headingFocusKey}
                    >
                        Loading leaderboard…
                    </RouteHeading>
                </div>
            </section>
        );
    }

    if (state.status === 'not-found') {
        return (
            <section
                className="leaderboard leaderboard--detail"
                aria-labelledby="leaderboard-not-found-title"
            >
                <div className="leaderboard__state leaderboard__state--error" role="alert">
                    <RouteHeading
                        id="leaderboard-not-found-title"
                        focusKey={headingFocusKey}
                    >
                        Leaderboard not found
                    </RouteHeading>
                    <p>No leaderboard matches “{gameId}”.</p>
                    <Link className="leaderboard__action" to="/leaderboards">
                        View all leaderboards
                    </Link>
                    {state.games.length > 0 && (
                        <nav className="leaderboard__known-games" aria-label="Available leaderboards">
                            {state.games.map((game) => (
                                <Link key={game.gameId} to={`/leaderboards/${game.gameId}`}>
                                    {game.displayName}
                                </Link>
                            ))}
                        </nav>
                    )}
                </div>
            </section>
        );
    }

    if (state.status === 'error') {
        return (
            <section
                className="leaderboard leaderboard--detail"
                aria-labelledby="leaderboard-error-title"
            >
                <div className="leaderboard__state leaderboard__state--error" role="alert">
                    <RouteHeading
                        id="leaderboard-error-title"
                        focusKey={headingFocusKey}
                    >
                        {state.game
                            ? `${state.game.displayName} leaderboard unavailable`
                            : 'Leaderboard unavailable'}
                    </RouteHeading>
                    <p>{state.message}</p>
                    <button
                        className="leaderboard__action"
                        type="button"
                        onClick={onRetry}
                    >
                        Try again
                    </button>
                    <Link className="leaderboard__text-link" to="/leaderboards">
                        Back to all leaderboards
                    </Link>
                </div>
            </section>
        );
    }

    return (
        <section
            className="leaderboard leaderboard--detail"
            aria-labelledby="game-leaderboard-title"
        >
            <header className="leaderboard__header leaderboard__header--detail">
                <Link className="leaderboard__back-link" to="/leaderboards">
                    ← All leaderboards
                </Link>
                <RouteHeading
                    id="game-leaderboard-title"
                    className="leaderboard__title"
                    focusKey={headingFocusKey}
                >
                    {state.game.displayName}
                </RouteHeading>
            </header>

            {leaderboardSourceNotice && <p className="leaderboard__source">{leaderboardSourceNotice}</p>}

            <LeaderboardTable game={state.game} leaderboard={state.leaderboard} />
        </section>
    );
}

const GameLeaderboard: React.FC = () => {
    const { gameId } = useParams<{ gameId: string }>();
    const [state, setState] = useState<DetailState>({ status: 'loading' });
    const [requestVersion, setRequestVersion] = useState(0);

    useEffect(() => {
        const abortController = new AbortController();

        const loadLeaderboard = async () => {
            setState({ status: 'loading' });

            try {
                const nextState = await loadGameLeaderboardState(
                    gameId,
                    abortController.signal,
                    { readCatalog: getLeaderboardCatalog, readGame: getGameLeaderboard }
                );

                if (!abortController.signal.aborted) {
                    setState(nextState);
                }
            } catch (error) {
                if (!isAbortError(error) && !abortController.signal.aborted) {
                    setState({
                        status: 'error',
                        game: null,
                        message: 'The leaderboard could not be loaded.',
                    });
                }
            }
        };

        void loadLeaderboard();
        return () => abortController.abort();
    }, [gameId, requestVersion]);

    return (
        <GameLeaderboardView
            gameId={gameId}
            state={state}
            onRetry={() => setRequestVersion((version) => version + 1)}
        />
    );
};

export default GameLeaderboard;
