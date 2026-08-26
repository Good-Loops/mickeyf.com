/** Environment-configured leaderboard service used by React pages. */
import { API_BASE } from '@/config/apiConfig';
import { createLeaderboardApi } from '@/services/leaderboardApi';

const leaderboardApi = createLeaderboardApi(API_BASE);

export const getLeaderboardCatalog = leaderboardApi.getCatalog;
export const getGameLeaderboard = leaderboardApi.getGame;

export {
    LeaderboardRequestError,
    type GameLeaderboardResponse,
    type LeaderboardCatalogGame,
    type LeaderboardCatalogResponse,
    type LeaderboardGameId,
    type LeaderboardRankState,
    type LeaderboardSubmissionState,
} from '@/services/leaderboardApi';
