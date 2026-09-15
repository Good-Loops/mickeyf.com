import { Capacitor } from '@capacitor/core';
import { API_BASE, PUBLIC_API_PREVIEW } from '@/config/apiConfig';
import { createLeaderboardApi } from './leaderboardApi';
import { apiFetch } from './apiFetch';

const showPublicPreview = import.meta.env.DEV && !Capacitor.isNativePlatform() && !PUBLIC_API_PREVIEW;
const displayApi = createLeaderboardApi(
    showPublicPreview ? '/__public-leaderboards' : API_BASE,
    showPublicPreview
        ? (input, init) => fetch(input, { ...init, credentials: 'omit' })
        : apiFetch
);

// Display data must not control local gameplay's submission eligibility.
export const getLeaderboardCatalog = displayApi.getCatalog;
export const getGameLeaderboard = displayApi.getGame;
export const leaderboardSourceNotice = PUBLIC_API_PREVIEW
    ? 'Public preview: accounts and scores are saved to the live website.'
    : showPublicPreview
    ? 'Live public leaderboard. Local test scores stay in the development database.'
    : null;

export type {
    GameLeaderboardResponse,
    LeaderboardCatalogGame,
    LeaderboardCatalogResponse,
} from './leaderboardApi';
