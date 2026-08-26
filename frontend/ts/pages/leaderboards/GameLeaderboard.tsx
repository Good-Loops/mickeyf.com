/** Direct-linkable leaderboard detail page for one server-catalog game. */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { RouteHeading } from '@/components/RouteHeading';
import {
    getGameLeaderboard,
    getLeaderboardCatalog,
    LeaderboardRequestError,
    type GameLeaderboardResponse,
    type LeaderboardCatalogGame,
} from '@/services/leaderboardService';

export type DetailState =
    | { status: 'loading' }
    | { status: 'not-found'; games: LeaderboardCatalogGame[] }
    | {
          status: 'error';
          game: LeaderboardCatalogGame | null;
          message: string;
      }
    | {
          status: 'success';
          game: LeaderboardCatalogGame;
          leaderboard: GameLeaderboardResponse;
      };

const numberFormatter = new Intl.NumberFormat('en-US');

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

type LeaderboardDetailReaders = {
    readCatalog: typeof getLeaderboardCatalog;
    readGame: typeof getGameLeaderboard;
};

type SettledDetailState = Exclude<DetailState, { status: 'loading' }>;

/** Resolves one detail route into a renderable state without React side effects. */
export async function loadGameLeaderboardState(
    gameId: string | undefined,
    signal?: AbortSignal,
    readers: LeaderboardDetailReaders = {
        readCatalog: getLeaderboardCatalog,
        readGame: getGameLeaderboard,
    }
): Promise<SettledDetailState> {
    let selectedGame: LeaderboardCatalogGame | null = null;
    let knownGames: LeaderboardCatalogGame[] = [];

    try {
        const catalog = await readers.readCatalog(signal);
        knownGames = catalog.games;
        selectedGame = catalog.games.find((game) => game.gameId === gameId) ?? null;

        if (!gameId || !selectedGame) {
            return { status: 'not-found', games: knownGames };
        }

        const leaderboard = await readers.readGame(selectedGame.gameId, signal);

        if (leaderboard.rulesVersion !== selectedGame.rulesVersion) {
            throw new LeaderboardRequestError(
                'The leaderboard service returned an unexpected response.',
                200,
                'INVALID_RESPONSE'
            );
        }

        return { status: 'success', game: selectedGame, leaderboard };
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }

        if (error instanceof LeaderboardRequestError && error.code === 'UNKNOWN_GAME') {
            return { status: 'not-found', games: knownGames };
        }

        return {
            status: 'error',
            game: selectedGame,
            message: error instanceof Error
                ? error.message
                : 'The leaderboard could not be loaded.',
        };
    }
}

function formatRankState(game: LeaderboardCatalogGame): string {
    switch (game.rankState) {
        case 'ranked':
            return 'Ranked';
        case 'unranked':
            return 'Unranked';
        case 'not-applicable':
            return 'High scores';
    }
}

function formatSubmissionState(game: LeaderboardCatalogGame): string {
    switch (game.submissionState) {
        case 'enabled':
            return 'Submissions open';
        case 'disabled':
            return 'Submissions disabled';
        case 'legacy-only':
            return 'In-game submissions';
    }
}

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
        return `${game.displayName} is currently unranked, and score submission is disabled.`;
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

    if (leaderboard.gameId === 'p4-vega') {
        return (
            <div
                className="leaderboard__table-wrapper"
                role="region"
                aria-label={`${game.displayName} leaderboard results`}
                tabIndex={0}
            >
                <table className="leaderboard__table">
                    <caption>{game.displayName} top scores</caption>
                    <thead>
                        <tr>
                            <th scope="col">Position</th>
                            <th scope="col">Player</th>
                            <th scope="col">{game.labels.score}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {leaderboard.entries.map((entry) => (
                            <tr key={entry.position}>
                                <td data-label="Position">#{entry.position}</td>
                                <td data-label="Player">{entry.userName}</td>
                                <td data-label={game.labels.score}>
                                    {numberFormatter.format(entry.score)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    }

    return (
        <div
            className="leaderboard__table-wrapper"
            role="region"
            aria-label={`${game.displayName} leaderboard results`}
            tabIndex={0}
        >
            <table className="leaderboard__table">
                <caption>{game.displayName} top completion times</caption>
                <thead>
                    <tr>
                        <th scope="col">Position</th>
                        <th scope="col">Player</th>
                        <th scope="col">{game.labels.completionTime ?? 'Time'}</th>
                        <th scope="col">{game.labels.score}</th>
                        <th scope="col">{game.labels.rank ?? 'Rank'}</th>
                    </tr>
                </thead>
                <tbody>
                    {leaderboard.entries.map((entry) => (
                        <tr key={entry.position}>
                            <td data-label="Position">#{entry.position}</td>
                            <td data-label="Player">{entry.userName}</td>
                            <td data-label={game.labels.completionTime ?? 'Time'}>
                                {formatCompletionTime(entry.completionTimeMs)}
                            </td>
                            <td data-label={game.labels.score}>
                                {numberFormatter.format(entry.score)}
                            </td>
                            <td data-label={game.labels.rank ?? 'Rank'}>{entry.rank}</td>
                        </tr>
                    ))}
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
            <section className="leaderboard" aria-labelledby="leaderboard-loading-title">
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
            <section className="leaderboard" aria-labelledby="leaderboard-not-found-title">
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
            <section className="leaderboard" aria-labelledby="leaderboard-error-title">
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
        <section className="leaderboard" aria-labelledby="game-leaderboard-title">
            <header className="leaderboard__header leaderboard__header--detail">
                <Link className="leaderboard__back-link" to="/leaderboards">
                    ← All leaderboards
                </Link>
                <p className="leaderboard__eyebrow">Game leaderboard</p>
                <RouteHeading
                    id="game-leaderboard-title"
                    className="leaderboard__title"
                    focusKey={headingFocusKey}
                >
                    {state.game.displayName}
                </RouteHeading>
                <div className="leaderboard__badges" aria-label="Leaderboard status">
                    <span>{formatRankState(state.game)}</span>
                    <span>{formatSubmissionState(state.game)}</span>
                </div>
            </header>

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
                    abortController.signal
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
