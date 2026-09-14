import { Capacitor } from '@capacitor/core';
import { API_BASE } from '@/config/apiConfig';
import { createLeaderboardApi } from './leaderboardApi';
import { apiFetch } from './apiFetch';

const showPublicPreview = import.meta.env.DEV && !Capacitor.isNativePlatform();
const displayApi = createLeaderboardApi(
    showPublicPreview ? '/__public-leaderboards' : API_BASE,
    showPublicPreview
        ? (input, init) => fetch(input, { ...init, credentials: 'omit' })
        : apiFetch
);

// Display data must not control local gameplay's submission eligibility.
export const getLeaderboardCatalog = displayApi.getCatalog;
export const getGameLeaderboard = displayApi.getGame;
export const leaderboardSourceNotice = showPublicPreview
    ? 'Live public leaderboard. Local test scores stay in the development database.'
    : null;

export type {
    GameLeaderboardResponse,
    LeaderboardCatalogGame,
    LeaderboardCatalogResponse,
} from './leaderboardApi';
