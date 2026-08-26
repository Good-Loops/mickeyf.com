/**
 * Version-one browser contract for public multi-game leaderboard reads.
 *
 * This module deliberately has no React or environment dependencies so the
 * transport boundary can be tested without rendering the application.
 */

export const LEADERBOARD_CONTRACT_VERSION = 1 as const;
export const LEADERBOARD_PAGE_SIZE = 10 as const;
export const LEADERBOARD_RULES_VERSION = 1 as const;

export type LeaderboardGameId = 'p4-vega' | 'three-bosses';
export type LeaderboardMetric = 'score' | 'completionTimeMs';
export type LeaderboardRankState = 'not-applicable' | 'unranked' | 'ranked';
export type LeaderboardSubmissionState = 'legacy-only' | 'disabled' | 'enabled';

export type LeaderboardCatalogGame = {
    gameId: LeaderboardGameId;
    displayName: string;
    rulesVersion: number;
    primaryMetric: LeaderboardMetric;
    sortDirection: 'ascending' | 'descending';
    labels: {
        score: string;
        completionTime: string | null;
        rank: string | null;
    };
    rankState: LeaderboardRankState;
    submissionState: LeaderboardSubmissionState;
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
          rulesVersion: typeof LEADERBOARD_RULES_VERSION;
          entries: P4VegaLeaderboardEntry[];
      }
    | {
          success: true;
          contractVersion: typeof LEADERBOARD_CONTRACT_VERSION;
          gameId: 'three-bosses';
          rulesVersion: typeof LEADERBOARD_RULES_VERSION;
          entries: ThreeBossesLeaderboardEntry[];
      };

export type LeaderboardApiErrorCode =
    | 'UNKNOWN_GAME'
    | 'RATE_LIMITED'
    | 'SERVER_ERROR';

export type LeaderboardClientErrorCode =
    | LeaderboardApiErrorCode
    | 'INVALID_RESPONSE'
    | 'NETWORK_ERROR';

type LeaderboardApiError = {
    success: false;
    contractVersion: typeof LEADERBOARD_CONTRACT_VERSION;
    error: LeaderboardApiErrorCode;
};

export class LeaderboardRequestError extends Error {
    readonly status: number;
    readonly code: LeaderboardClientErrorCode;

    constructor(message: string, status: number, code: LeaderboardClientErrorCode) {
        super(message);
        this.name = 'LeaderboardRequestError';
        this.status = status;
        this.code = code;
    }
}

export type LeaderboardApi = {
    getCatalog(signal?: AbortSignal): Promise<LeaderboardCatalogResponse>;
    getGame(
        gameId: string,
        signal?: AbortSignal
    ): Promise<GameLeaderboardResponse>;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0;
}

function isInteger(value: unknown): value is number {
    return Number.isSafeInteger(value);
}

function isGameId(value: unknown): value is LeaderboardGameId {
    return value === 'p4-vega' || value === 'three-bosses';
}

function isCatalogGame(value: unknown): value is LeaderboardCatalogGame {
    if (!isRecord(value) || !isRecord(value.labels)) {
        return false;
    }

    return isGameId(value.gameId)
        && typeof value.displayName === 'string'
        && value.displayName.length > 0
        && isPositiveInteger(value.rulesVersion)
        && (value.primaryMetric === 'score' || value.primaryMetric === 'completionTimeMs')
        && (value.sortDirection === 'ascending' || value.sortDirection === 'descending')
        && typeof value.labels.score === 'string'
        && (typeof value.labels.completionTime === 'string' || value.labels.completionTime === null)
        && (typeof value.labels.rank === 'string' || value.labels.rank === null)
        && (
            value.rankState === 'not-applicable'
            || value.rankState === 'unranked'
            || value.rankState === 'ranked'
        )
        && (
            value.submissionState === 'legacy-only'
            || value.submissionState === 'disabled'
            || value.submissionState === 'enabled'
        );
}

function isCatalogResponse(value: unknown): value is LeaderboardCatalogResponse {
    return isRecord(value)
        && value.success === true
        && value.contractVersion === LEADERBOARD_CONTRACT_VERSION
        && Array.isArray(value.games)
        && value.games.every(isCatalogGame);
}

function isP4VegaEntry(value: unknown): value is P4VegaLeaderboardEntry {
    return isRecord(value)
        && isPositiveInteger(value.position)
        && typeof value.userName === 'string'
        && isInteger(value.score);
}

function isThreeBossesEntry(value: unknown): value is ThreeBossesLeaderboardEntry {
    return isRecord(value)
        && isPositiveInteger(value.position)
        && typeof value.userName === 'string'
        && isInteger(value.score)
        && isPositiveInteger(value.completionTimeMs)
        && value.rank === 'UNRANKED';
}

function isGameResponse(
    value: unknown,
    requestedGameId: string
): value is GameLeaderboardResponse {
    if (
        !isRecord(value)
        || value.success !== true
        || value.contractVersion !== LEADERBOARD_CONTRACT_VERSION
        || value.gameId !== requestedGameId
        || !isGameId(value.gameId)
        || value.rulesVersion !== LEADERBOARD_RULES_VERSION
        || !Array.isArray(value.entries)
        || value.entries.length > LEADERBOARD_PAGE_SIZE
    ) {
        return false;
    }

    const isEntry = value.gameId === 'p4-vega'
        ? isP4VegaEntry
        : isThreeBossesEntry;

    return value.entries.every(
        (entry, index) => isEntry(entry) && entry.position === index + 1
    );
}

function isApiError(value: unknown): value is LeaderboardApiError {
    return isRecord(value)
        && value.success === false
        && value.contractVersion === LEADERBOARD_CONTRACT_VERSION
        && (
            value.error === 'UNKNOWN_GAME'
            || value.error === 'RATE_LIMITED'
            || value.error === 'SERVER_ERROR'
        );
}

function messageForApiError(code: LeaderboardApiErrorCode): string {
    switch (code) {
        case 'UNKNOWN_GAME':
            return 'That leaderboard does not exist.';
        case 'RATE_LIMITED':
            return 'Too many leaderboard requests. Please try again shortly.';
        case 'SERVER_ERROR':
            return 'The leaderboard service is temporarily unavailable.';
    }
}

function isAbortError(error: unknown): boolean {
    return isRecord(error) && error.name === 'AbortError';
}

function normalizeApiBase(apiBase: string | undefined): string {
    return (apiBase ?? '').replace(/\/+$/, '');
}

async function readJson(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        throw new LeaderboardRequestError(
            'The leaderboard service returned an unexpected response.',
            response.status,
            'INVALID_RESPONSE'
        );
    }
}

/** Creates the public leaderboard GET client for a configured API origin. */
export function createLeaderboardApi(
    apiBase: string | undefined,
    fetchImplementation: typeof fetch = fetch
): LeaderboardApi {
    const normalizedApiBase = normalizeApiBase(apiBase);

    const request = async (path: string, signal?: AbortSignal): Promise<unknown> => {
        let response: Response;

        try {
            response = await fetchImplementation(`${normalizedApiBase}${path}`, {
                method: 'GET',
                credentials: 'include',
                headers: {
                    Accept: 'application/json',
                },
                signal,
            });
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }

            throw new LeaderboardRequestError(
                'Unable to reach the leaderboard service.',
                0,
                'NETWORK_ERROR'
            );
        }

        const payload = await readJson(response);

        if (!response.ok) {
            if (isApiError(payload)) {
                throw new LeaderboardRequestError(
                    messageForApiError(payload.error),
                    response.status,
                    payload.error
                );
            }

            throw new LeaderboardRequestError(
                'The leaderboard request could not be completed.',
                response.status,
                'INVALID_RESPONSE'
            );
        }

        return payload;
    };

    return {
        async getCatalog(signal) {
            const payload = await request('/api/leaderboards', signal);

            if (!isCatalogResponse(payload)) {
                throw new LeaderboardRequestError(
                    'The leaderboard service returned an unexpected response.',
                    200,
                    'INVALID_RESPONSE'
                );
            }

            return payload;
        },

        async getGame(gameId, signal) {
            const encodedGameId = encodeURIComponent(gameId);
            const payload = await request(`/api/leaderboards/${encodedGameId}`, signal);

            if (!isGameResponse(payload, gameId)) {
                throw new LeaderboardRequestError(
                    'The leaderboard service returned an unexpected response.',
                    200,
                    'INVALID_RESPONSE'
                );
            }

            return payload;
        },
    };
}
