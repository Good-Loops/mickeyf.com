/**
 * Version-one browser transport for multi-game leaderboard reads and the
 * authenticated Three Bosses run submission boundary.
 *
 * This module deliberately has no React or environment dependencies so the
 * transport boundary can be tested without rendering the application.
 */

export const LEADERBOARD_CONTRACT_VERSION = 1 as const;
export const THREE_BOSSES_RULES_VERSION = 1 as const;
const LEADERBOARD_PAGE_SIZE = 10 as const;
const THREE_BOSSES_MIN_COMPLETION_TIME_MS = 1 as const;
const THREE_BOSSES_MAX_COMPLETION_TIME_MS = 86_400_000 as const;

const CANONICAL_V4_UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type LeaderboardGameId = 'p4-vega' | 'three-bosses';
type LeaderboardMetric = 'score' | 'completionTimeMs';
type LeaderboardRankState = 'not-applicable' | 'unranked' | 'ranked';
type LeaderboardSubmissionState = 'legacy-only' | 'disabled' | 'enabled';
type ThreeBossesRank = 'S' | 'A' | 'B' | 'C' | 'D';

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

type P4VegaLeaderboardEntry = {
    position: number;
    userName: string;
    score: number;
};

type ThreeBossesLeaderboardEntry = {
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
          rulesVersion: number;
          entries: P4VegaLeaderboardEntry[];
      }
    | {
          success: true;
          contractVersion: typeof LEADERBOARD_CONTRACT_VERSION;
          gameId: 'three-bosses';
          rulesVersion: number;
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
        rank: ThreeBossesRank;
    };
};

type LeaderboardApiErrorCode =
    | 'UNKNOWN_GAME'
    | 'SUBMISSION_DISABLED'
    | 'UNSUPPORTED_CONTRACT_VERSION'
    | 'UNSUPPORTED_RULES_VERSION'
    | 'INVALID_RUN'
    | 'UNAUTHORIZED'
    | 'IDEMPOTENCY_CONFLICT'
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

type LeaderboardApi = {
    getCatalog(signal?: AbortSignal): Promise<LeaderboardCatalogResponse>;
    getGame(
        gameId: string,
        signal?: AbortSignal
    ): Promise<GameLeaderboardResponse>;
    submitThreeBossesRun(
        request: ThreeBossesRunSubmissionRequest,
        signal?: AbortSignal
    ): Promise<ThreeBossesRunSubmissionResponse>;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, expectedKeys: readonly string[]): boolean {
    const actualKeys = Object.keys(value).sort();
    const sortedExpectedKeys = [...expectedKeys].sort();
    return actualKeys.length === sortedExpectedKeys.length
        && actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

function isPositiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0;
}

function isThreeBossesRank(value: unknown): value is ThreeBossesRank {
    return value === 'S'
        || value === 'A'
        || value === 'B'
        || value === 'C'
        || value === 'D';
}

function isInteger(value: unknown): value is number {
    return Number.isSafeInteger(value);
}

export function isCanonicalThreeBossesRunId(value: unknown): value is string {
    return typeof value === 'string' && CANONICAL_V4_UUID.test(value);
}

export function isValidThreeBossesCompletionTimeMs(value: unknown): value is number {
    return Number.isSafeInteger(value)
        && (value as number) >= THREE_BOSSES_MIN_COMPLETION_TIME_MS
        && (value as number) <= THREE_BOSSES_MAX_COMPLETION_TIME_MS;
}

export function isThreeBossesSubmissionEnabled(
    game: LeaderboardCatalogGame
): boolean {
    return game.gameId === 'three-bosses'
        && game.rulesVersion === THREE_BOSSES_RULES_VERSION
        && game.rankState === 'ranked'
        && game.submissionState === 'enabled';
}

function isThreeBossesRunSubmissionRequest(
    value: unknown
): value is ThreeBossesRunSubmissionRequest {
    return isRecord(value)
        && hasExactKeys(value, [
            'contractVersion',
            'rulesVersion',
            'runId',
            'completionTimeMs',
        ])
        && value.contractVersion === LEADERBOARD_CONTRACT_VERSION
        && value.rulesVersion === THREE_BOSSES_RULES_VERSION
        && isCanonicalThreeBossesRunId(value.runId)
        && isValidThreeBossesCompletionTimeMs(value.completionTimeMs);
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
        && isThreeBossesRank(value.rank);
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
        || !isPositiveInteger(value.rulesVersion)
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

function isThreeBossesRunSubmissionResponse(
    value: unknown,
    request: ThreeBossesRunSubmissionRequest
): value is ThreeBossesRunSubmissionResponse {
    if (
        !isRecord(value)
        || !hasExactKeys(value, [
            'success',
            'contractVersion',
            'gameId',
            'rulesVersion',
            'runId',
            'replayed',
            'personalBest',
            'result',
        ])
        || !isRecord(value.result)
        || !hasExactKeys(value.result, [
            'score',
            'completionTimeMs',
            'rank',
        ])
    ) {
        return false;
    }

    return value.success === true
        && value.contractVersion === LEADERBOARD_CONTRACT_VERSION
        && value.gameId === 'three-bosses'
        && value.rulesVersion === request.rulesVersion
        && value.runId === request.runId
        && typeof value.replayed === 'boolean'
        && typeof value.personalBest === 'boolean'
        && isPositiveInteger(value.result.score)
        && value.result.completionTimeMs === request.completionTimeMs
        && isThreeBossesRank(value.result.rank);
}

function isApiError(value: unknown): value is LeaderboardApiError {
    return isRecord(value)
        && hasExactKeys(value, ['success', 'contractVersion', 'error'])
        && value.success === false
        && value.contractVersion === LEADERBOARD_CONTRACT_VERSION
        && (
            value.error === 'UNKNOWN_GAME'
            || value.error === 'SUBMISSION_DISABLED'
            || value.error === 'UNSUPPORTED_CONTRACT_VERSION'
            || value.error === 'UNSUPPORTED_RULES_VERSION'
            || value.error === 'INVALID_RUN'
            || value.error === 'UNAUTHORIZED'
            || value.error === 'IDEMPOTENCY_CONFLICT'
            || value.error === 'RATE_LIMITED'
            || value.error === 'SERVER_ERROR'
        );
}

const API_ERROR_STATUS: Readonly<Record<LeaderboardApiErrorCode, number>> = Object.freeze({
    UNKNOWN_GAME: 404,
    SUBMISSION_DISABLED: 403,
    UNSUPPORTED_CONTRACT_VERSION: 400,
    UNSUPPORTED_RULES_VERSION: 400,
    INVALID_RUN: 400,
    UNAUTHORIZED: 401,
    IDEMPOTENCY_CONFLICT: 409,
    RATE_LIMITED: 429,
    SERVER_ERROR: 500,
});

function messageForApiError(code: LeaderboardApiErrorCode): string {
    switch (code) {
        case 'UNKNOWN_GAME':
            return 'That leaderboard does not exist.';
        case 'SUBMISSION_DISABLED':
            return 'Three Bosses submissions are currently disabled.';
        case 'UNSUPPORTED_CONTRACT_VERSION':
            return 'The leaderboard client version is not supported.';
        case 'UNSUPPORTED_RULES_VERSION':
            return 'This Three Bosses rules version is not supported.';
        case 'INVALID_RUN':
            return 'The Three Bosses run result is invalid.';
        case 'UNAUTHORIZED':
            return 'Log in before submitting a Three Bosses run.';
        case 'IDEMPOTENCY_CONFLICT':
            return 'That run identifier was already used for different data.';
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
    } catch (error) {
        if (isAbortError(error)) throw error;
        throw new LeaderboardRequestError(
            'The leaderboard service returned an unexpected response.',
            response.status,
            'INVALID_RESPONSE'
        );
    }
}

/** Creates the leaderboard client for a configured API origin. */
export function createLeaderboardApi(
    apiBase: string | undefined,
    fetchImplementation: typeof fetch = fetch
): LeaderboardApi {
    const normalizedApiBase = normalizeApiBase(apiBase);

    const request = async (
        path: string,
        method: 'GET' | 'POST',
        signal?: AbortSignal,
        body?: unknown
    ): Promise<{ payload: unknown; status: number }> => {
        let response: Response;
        const headers: Record<string, string> = {
            Accept: 'application/json',
        };
        let serializedBody: string | undefined;

        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            serializedBody = JSON.stringify(body);
        }

        try {
            response = await fetchImplementation(`${normalizedApiBase}${path}`, {
                method,
                credentials: 'include',
                headers,
                body: serializedBody,
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
            if (
                isApiError(payload)
                && API_ERROR_STATUS[payload.error] === response.status
            ) {
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

        return { payload, status: response.status };
    };

    return {
        async getCatalog(signal) {
            const { payload } = await request('/api/leaderboards', 'GET', signal);

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
            const { payload } = await request(
                `/api/leaderboards/${encodedGameId}`,
                'GET',
                signal
            );

            if (!isGameResponse(payload, gameId)) {
                throw new LeaderboardRequestError(
                    'The leaderboard service returned an unexpected response.',
                    200,
                    'INVALID_RESPONSE'
                );
            }

            return payload;
        },

        async submitThreeBossesRun(submission, signal) {
            if (!isRecord(submission)) {
                throw new LeaderboardRequestError(
                    messageForApiError('INVALID_RUN'),
                    API_ERROR_STATUS.INVALID_RUN,
                    'INVALID_RUN'
                );
            }
            if (submission.contractVersion !== LEADERBOARD_CONTRACT_VERSION) {
                throw new LeaderboardRequestError(
                    messageForApiError('UNSUPPORTED_CONTRACT_VERSION'),
                    API_ERROR_STATUS.UNSUPPORTED_CONTRACT_VERSION,
                    'UNSUPPORTED_CONTRACT_VERSION'
                );
            }
            if (submission.rulesVersion !== THREE_BOSSES_RULES_VERSION) {
                throw new LeaderboardRequestError(
                    messageForApiError('UNSUPPORTED_RULES_VERSION'),
                    API_ERROR_STATUS.UNSUPPORTED_RULES_VERSION,
                    'UNSUPPORTED_RULES_VERSION'
                );
            }
            if (!isThreeBossesRunSubmissionRequest(submission)) {
                throw new LeaderboardRequestError(
                    messageForApiError('INVALID_RUN'),
                    API_ERROR_STATUS.INVALID_RUN,
                    'INVALID_RUN'
                );
            }

            const { payload, status } = await request(
                '/api/leaderboards/three-bosses/runs',
                'POST',
                signal,
                submission
            );
            if (
                !isThreeBossesRunSubmissionResponse(payload, submission)
                || (payload.replayed ? status !== 200 : status !== 201)
            ) {
                throw new LeaderboardRequestError(
                    'The leaderboard service returned an unexpected response.',
                    status,
                    'INVALID_RESPONSE'
                );
            }

            return payload;
        },
    };
}
