/**
 * Version-one public DTOs and mechanical bounds for the additive leaderboard
 * API. Runtime handlers will be added only after the live schema preflight and
 * migration review are complete.
 */
import type {
    LeaderboardMetric,
    RankState,
    SortDirection,
    SubmissionState,
} from './gameCatalog';

export const LEADERBOARD_CONTRACT_VERSION = 1 as const;
export const LEADERBOARD_PAGE_SIZE = 10 as const;
export const THREE_BOSSES_RULES_VERSION = 1 as const;
export const THREE_BOSSES_MIN_COMPLETION_TIME_MS = 1 as const;
export const THREE_BOSSES_MAX_COMPLETION_TIME_MS = 86_400_000 as const;
export const THREE_BOSSES_SCORE_NUMERATOR = 100_000_000 as const;

const CANONICAL_V4_UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type LeaderboardCatalogGame = {
    gameId: 'p4-vega' | 'three-bosses';
    displayName: string;
    rulesVersion: number;
    primaryMetric: LeaderboardMetric;
    sortDirection: SortDirection;
    labels: {
        score: string;
        completionTime: string | null;
        rank: string | null;
    };
    rankState: RankState;
    submissionState: SubmissionState;
};

export type LeaderboardCatalogResponse = {
    success: true;
    contractVersion: typeof LEADERBOARD_CONTRACT_VERSION;
    games: LeaderboardCatalogGame[];
};

export type P4VegaLeaderboardEntry = {
    position: number;
    userName: string;
    score: number;
};

export type ThreeBossesLeaderboardEntry = {
    position: number;
    userName: string;
    score: number;
    completionTimeMs: number;
    rank: 'UNRANKED';
};

export type GameLeaderboardResponse =
    | {
          success: true;
          contractVersion: typeof LEADERBOARD_CONTRACT_VERSION;
          gameId: 'p4-vega';
          rulesVersion: 1;
          entries: P4VegaLeaderboardEntry[];
      }
    | {
          success: true;
          contractVersion: typeof LEADERBOARD_CONTRACT_VERSION;
          gameId: 'three-bosses';
          rulesVersion: typeof THREE_BOSSES_RULES_VERSION;
          entries: ThreeBossesLeaderboardEntry[];
      };

export type ThreeBossesRunSubmissionRequest = {
    contractVersion: typeof LEADERBOARD_CONTRACT_VERSION;
    rulesVersion: typeof THREE_BOSSES_RULES_VERSION;
    runId: string;
    completionTimeMs: number;
};

export type ThreeBossesRunSubmissionResponse = {
    success: true;
    contractVersion: typeof LEADERBOARD_CONTRACT_VERSION;
    gameId: 'three-bosses';
    rulesVersion: typeof THREE_BOSSES_RULES_VERSION;
    runId: string;
    replayed: boolean;
    personalBest: boolean;
    result: {
        score: number;
        completionTimeMs: number;
        rank: 'UNRANKED';
    };
};

export type LeaderboardApiErrorCode =
    | 'UNKNOWN_GAME'
    | 'SUBMISSION_DISABLED'
    | 'UNSUPPORTED_CONTRACT_VERSION'
    | 'UNSUPPORTED_RULES_VERSION'
    | 'INVALID_RUN'
    | 'UNAUTHORIZED'
    | 'IDEMPOTENCY_CONFLICT'
    | 'RATE_LIMITED'
    | 'SERVER_ERROR';

export type LeaderboardApiError = {
    success: false;
    contractVersion: typeof LEADERBOARD_CONTRACT_VERSION;
    error: LeaderboardApiErrorCode;
};

export function isCanonicalV4RunId(value: unknown): value is string {
    return typeof value === 'string' && CANONICAL_V4_UUID.test(value);
}

export function isValidThreeBossesCompletionTimeMs(value: unknown): value is number {
    return Number.isSafeInteger(value)
        && (value as number) >= THREE_BOSSES_MIN_COMPLETION_TIME_MS
        && (value as number) <= THREE_BOSSES_MAX_COMPLETION_TIME_MS;
}

export function calculateThreeBossesScore(completionTimeMs: number): number {
    if (!isValidThreeBossesCompletionTimeMs(completionTimeMs)) {
        throw new RangeError('completionTimeMs is outside the version-one contract');
    }

    // All inputs are positive, so floor(x + 0.5) exactly expresses
    // midpoint-away-from-zero rounding without a floating-point sign branch.
    return Math.max(
        1,
        Math.floor(THREE_BOSSES_SCORE_NUMERATOR / completionTimeMs + 0.5)
    );
}
