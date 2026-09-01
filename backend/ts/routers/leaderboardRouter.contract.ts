/**
 * Additive version-one multi-game leaderboard route contract.
 *
 * Paths are relative to the `/api/leaderboards` application mount point.
 */
import type {
    GameLeaderboardResponse,
    LeaderboardApiError,
    LeaderboardCatalogResponse,
    ThreeBossesRunSubmissionRequest,
    ThreeBossesRunSubmissionResponse,
    ThreeBossesRunTicketRequest,
    ThreeBossesRunTicketResponse,
} from '../leaderboards/leaderboardContract';
import type { RouteContract } from './routeContract';

/** @category Backend — DTOs */
export type GetLeaderboardCatalogRequest = Record<string, never>;

/** @category Backend — DTOs */
export type GetLeaderboardCatalogResponse =
    | LeaderboardCatalogResponse
    | LeaderboardApiError<'RATE_LIMITED' | 'SERVER_ERROR'>;

/** @category Backend — DTOs */
export type GetGameLeaderboardRequest = {
    gameId: string;
};

/** @category Backend — DTOs */
export type GetGameLeaderboardResponse =
    | GameLeaderboardResponse
    | LeaderboardApiError<'UNKNOWN_GAME' | 'RATE_LIMITED' | 'SERVER_ERROR'>;

/** @category Backend — DTOs */
export type SubmitThreeBossesRunResponse =
    | ThreeBossesRunSubmissionResponse
    | LeaderboardApiError<
          | 'SUBMISSION_DISABLED'
          | 'UNSUPPORTED_CONTRACT_VERSION'
          | 'UNSUPPORTED_RULES_VERSION'
          | 'INVALID_RUN'
          | 'UNAUTHORIZED'
          | 'IDEMPOTENCY_CONFLICT'
          | 'RATE_LIMITED'
          | 'SERVER_ERROR'
      >;

/** @category Backend — DTOs */
export type IssueThreeBossesRunTicketResponse =
    | ThreeBossesRunTicketResponse
    | LeaderboardApiError<
          | 'SUBMISSION_DISABLED'
          | 'UNSUPPORTED_CONTRACT_VERSION'
          | 'UNSUPPORTED_RULES_VERSION'
          | 'INVALID_RUN'
          | 'UNAUTHORIZED'
          | 'RATE_LIMITED'
          | 'SERVER_ERROR'
      >;

/** @category Backend — Contracts */
export type LeaderboardRoutesContract = {
    readonly routes: readonly (
        | RouteContract<GetLeaderboardCatalogRequest, GetLeaderboardCatalogResponse>
        | RouteContract<GetGameLeaderboardRequest, GetGameLeaderboardResponse>
        | RouteContract<ThreeBossesRunTicketRequest, IssueThreeBossesRunTicketResponse>
        | RouteContract<ThreeBossesRunSubmissionRequest, SubmitThreeBossesRunResponse>
    )[];
};

/** @category Backend — Contracts */
export const leaderboardRoutesContract: LeaderboardRoutesContract = {
    routes: [
        {
            id: 'leaderboards.catalog',
            method: 'GET',
            path: '/',
            auth: 'public',
            request: {} as GetLeaderboardCatalogRequest,
            response: {} as GetLeaderboardCatalogResponse,
        },
        {
            id: 'leaderboards.three-bosses.issue-run-ticket',
            method: 'POST',
            path: '/three-bosses/run-tickets',
            auth: 'user',
            request: {} as ThreeBossesRunTicketRequest,
            response: {} as IssueThreeBossesRunTicketResponse,
        },
        {
            id: 'leaderboards.three-bosses.submit-run',
            method: 'POST',
            path: '/three-bosses/runs',
            auth: 'user',
            request: {} as ThreeBossesRunSubmissionRequest,
            response: {} as SubmitThreeBossesRunResponse,
        },
        {
            id: 'leaderboards.game',
            method: 'GET',
            path: '/:gameId',
            auth: 'public',
            request: {} as GetGameLeaderboardRequest,
            response: {} as GetGameLeaderboardResponse,
        },
    ],
};
