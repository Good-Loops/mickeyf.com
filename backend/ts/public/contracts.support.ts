/**
 * Backend public surface: router contract support types.
 *
 * Export only request/response shapes and other signature-adjacent contract types.
 */
export type { VerifyTokenRequest } from '../routers/authRouter.contract';
export type { VerifyTokenResponse } from '../routers/authRouter.contract';
export type { LogoutRequest } from '../routers/authRouter.contract';
export type { LogoutResponse } from '../routers/authRouter.contract';
export type { ApiErrorCode } from '../routers/mainRouter.contract';
export type { ApiError } from '../routers/mainRouter.contract';
export type { PostUsersRequest } from '../routers/mainRouter.contract';
export type { SignupResponse } from '../routers/mainRouter.contract';
export type { LoginResponse } from '../routers/mainRouter.contract';
export type { SubmitScoreResponse } from '../routers/mainRouter.contract';
export type { GetLeaderboardResponse } from '../routers/mainRouter.contract';
export type { PostUsersResponse } from '../routers/mainRouter.contract';
export type { GetUsersResponse } from '../routers/mainRouter.contract';
export type {
    GetGameLeaderboardRequest,
    GetGameLeaderboardResponse,
    GetLeaderboardCatalogRequest,
    GetLeaderboardCatalogResponse,
    SubmitThreeBossesRunResponse,
} from '../routers/leaderboardRouter.contract';
export type {
    GameLeaderboardResponse,
    LeaderboardApiError,
    LeaderboardApiErrorCode,
    LeaderboardCatalogGame,
    LeaderboardCatalogResponse,
    P4VegaLeaderboardEntry,
    ThreeBossesLeaderboardEntry,
    ThreeBossesRunSubmissionRequest,
    ThreeBossesRunSubmissionResponse,
} from '../leaderboards/leaderboardContract';
export {
    LEADERBOARD_CONTRACT_VERSION,
    LEADERBOARD_PAGE_SIZE,
} from '../leaderboards/leaderboardContract';
export {
    GAME_IDS,
    P4_VEGA_RULES_VERSION,
    THREE_BOSSES_RULES_VERSION,
} from '../leaderboards/gameCatalog';
export type {
    GameId,
    LeaderboardMetric,
    RankState,
    SortDirection,
    SubmissionState,
} from '../leaderboards/gameCatalog';
