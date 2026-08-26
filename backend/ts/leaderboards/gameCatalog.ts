/**
 * Server-owned catalog for games that can appear in the multi-game leaderboard.
 *
 * Stable identifiers are deliberately separate from display names and routes.
 * Clients may render this metadata, but they must not define ranking or
 * submission policy independently of the backend.
 */

export const GAME_IDS = Object.freeze(['p4-vega', 'three-bosses'] as const);
export const P4_VEGA_RULES_VERSION = 1 as const;
export const THREE_BOSSES_RULES_VERSION = 1 as const;

export type GameId = (typeof GAME_IDS)[number];
export type LeaderboardMetric = 'score' | 'completionTimeMs';
export type SortDirection = 'ascending' | 'descending';
export type RankState = 'not-applicable' | 'unranked' | 'ranked';
export type SubmissionState = 'legacy-only' | 'disabled' | 'enabled';

export type LeaderboardGameDefinition = Readonly<{
    gameId: GameId;
    displayName: string;
    rulesVersion: number;
    primaryMetric: LeaderboardMetric;
    sortDirection: SortDirection;
    scoreLabel: string;
    completionTimeLabel: string | null;
    rankLabel: string | null;
    rankState: RankState;
    submissionState: SubmissionState;
}>;

export const GAME_DEFINITIONS: Readonly<Record<GameId, LeaderboardGameDefinition>> =
    Object.freeze({
        'p4-vega': Object.freeze({
            gameId: 'p4-vega',
            displayName: 'p4-Vega',
            rulesVersion: P4_VEGA_RULES_VERSION,
            primaryMetric: 'score',
            sortDirection: 'descending',
            scoreLabel: 'Score',
            completionTimeLabel: null,
            rankLabel: null,
            rankState: 'not-applicable',
            submissionState: 'legacy-only',
        }),
        'three-bosses': Object.freeze({
            gameId: 'three-bosses',
            displayName: 'Three Bosses',
            rulesVersion: THREE_BOSSES_RULES_VERSION,
            primaryMetric: 'completionTimeMs',
            sortDirection: 'ascending',
            scoreLabel: 'Score',
            completionTimeLabel: 'Time',
            rankLabel: 'Rank',
            rankState: 'unranked',
            submissionState: 'disabled',
        }),
    });

export function isGameId(value: unknown): value is GameId {
    return typeof value === 'string'
        && (GAME_IDS as readonly string[]).includes(value);
}

export function getGameDefinition(gameId: GameId): LeaderboardGameDefinition {
    return GAME_DEFINITIONS[gameId];
}
