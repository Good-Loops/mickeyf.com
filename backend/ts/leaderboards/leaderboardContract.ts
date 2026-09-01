/**
 * Version-one public DTOs and mechanical bounds for the additive leaderboard
 * API.
 */
import {
    P4_VEGA_RULES_VERSION,
    THREE_BOSSES_RULES_VERSION,
    type LeaderboardMetric,
    type RankState,
    type SortDirection,
    type SubmissionState,
} from './gameCatalog';

export { THREE_BOSSES_RULES_VERSION } from './gameCatalog';

export const LEADERBOARD_CONTRACT_VERSION = 1 as const;
export const LEADERBOARD_PAGE_SIZE = 10 as const;
export const THREE_BOSSES_MIN_COMPLETION_TIME_MS = 10_000 as const;
export const THREE_BOSSES_MAX_COMPLETION_TIME_MS = 86_400_000 as const;
export const THREE_BOSSES_SCORE_NUMERATOR = 10_000_000_000 as const;
export const THREE_BOSSES_MAX_SCORE = 2_147_483_647 as const;
export const THREE_BOSSES_S_RANK_MAX_EXCLUSIVE_MS = 60_000 as const;
export const THREE_BOSSES_A_RANK_MAX_MS = 80_000 as const;
export const THREE_BOSSES_B_RANK_MAX_MS = 100_000 as const;
export const THREE_BOSSES_C_RANK_MAX_MS = 120_000 as const;

export type ThreeBossesRank = 'S' | 'A' | 'B' | 'C' | 'D';

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
    rank: ThreeBossesRank;
};

export type GameLeaderboardResponse =
    | {
          success: true;
          contractVersion: typeof LEADERBOARD_CONTRACT_VERSION;
          gameId: 'p4-vega';
          rulesVersion: typeof P4_VEGA_RULES_VERSION;
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
    runTicket: string;
};

export type ThreeBossesRunTicketRequest = {
    contractVersion: typeof LEADERBOARD_CONTRACT_VERSION;
    rulesVersion: typeof THREE_BOSSES_RULES_VERSION;
    runId: string;
};

export type ThreeBossesRunTicketResponse = {
    success: true;
    contractVersion: typeof LEADERBOARD_CONTRACT_VERSION;
    gameId: 'three-bosses';
    rulesVersion: typeof THREE_BOSSES_RULES_VERSION;
    runId: string;
    runTicket: string;
    expiresAt: string;
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
        rank: ThreeBossesRank;
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

export type LeaderboardApiError<
    ErrorCode extends LeaderboardApiErrorCode = LeaderboardApiErrorCode
> = {
    success: false;
    contractVersion: typeof LEADERBOARD_CONTRACT_VERSION;
    error: ErrorCode;
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
        Math.min(
            THREE_BOSSES_MAX_SCORE,
            Math.floor(THREE_BOSSES_SCORE_NUMERATOR / completionTimeMs + 0.5)
        )
    );
}

export function calculateThreeBossesRank(
    completionTimeMs: number
): ThreeBossesRank {
    if (!isValidThreeBossesCompletionTimeMs(completionTimeMs)) {
        throw new RangeError('completionTimeMs is outside the version-one contract');
    }

    if (completionTimeMs < THREE_BOSSES_S_RANK_MAX_EXCLUSIVE_MS) return 'S';
    if (completionTimeMs <= THREE_BOSSES_A_RANK_MAX_MS) return 'A';
    if (completionTimeMs <= THREE_BOSSES_B_RANK_MAX_MS) return 'B';
    if (completionTimeMs <= THREE_BOSSES_C_RANK_MAX_MS) return 'C';
    return 'D';
}
