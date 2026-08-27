/** Environment-configured leaderboard service used by React pages. */
import { API_BASE } from '@/config/apiConfig';
import { createLeaderboardApi } from '@/services/leaderboardApi';

const leaderboardApi = createLeaderboardApi(API_BASE);

export const getLeaderboardCatalog = leaderboardApi.getCatalog;
export const getGameLeaderboard = leaderboardApi.getGame;
export const submitThreeBossesRun = leaderboardApi.submitThreeBossesRun;

export {
    LeaderboardRequestError,
    type GameLeaderboardResponse,
    type LeaderboardCatalogGame,
    type LeaderboardCatalogResponse,
} from '@/services/leaderboardApi';
