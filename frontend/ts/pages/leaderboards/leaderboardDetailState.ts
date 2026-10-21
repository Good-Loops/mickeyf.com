/** Detail-route loading decisions, independent of React and API configuration. */
import {
    LeaderboardRequestError,
    type GameLeaderboardResponse,
    type LeaderboardCatalogGame,
    type LeaderboardCatalogResponse,
} from '../../services/leaderboardApi.ts';

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

type LeaderboardDetailReaders = {
    readCatalog(signal?: AbortSignal): Promise<LeaderboardCatalogResponse>;
    readGame(gameId: string, signal?: AbortSignal): Promise<GameLeaderboardResponse>;
};

type SettledDetailState = Exclude<DetailState, { status: 'loading' }>;

export function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

/** Resolves a detail route using readers supplied by the page or a test. */
export async function loadGameLeaderboardState(
    gameId: string | undefined,
    signal: AbortSignal | undefined,
    readers: LeaderboardDetailReaders
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
