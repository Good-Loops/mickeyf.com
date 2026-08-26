import { ErrorRequestHandler } from 'express';
import { LEADERBOARD_CONTRACT_VERSION } from '../leaderboards/leaderboardContract';

type RequestUriError = URIError & {
    status?: number;
    statusCode?: number;
};

type RequestBodyError = Error & {
    status?: number;
    statusCode?: number;
    type?: string;
};

/** Converts unexpected failures inside the generic router to its versioned DTO. */
export const leaderboardRequestErrorHandler: ErrorRequestHandler = (
    error,
    req,
    res,
    next
) => {
    if (res.headersSent) {
        next(error);
        return;
    }

    const requestBodyError = error as RequestBodyError;
    if (
        req.method === 'POST'
        && req.path === '/three-bosses/runs'
        && (
            requestBodyError.type === 'entity.parse.failed'
            || requestBodyError.type === 'entity.too.large'
        )
    ) {
        res.status(400).json({
            success: false,
            contractVersion: LEADERBOARD_CONTRACT_VERSION,
            error: 'INVALID_RUN',
        });
        return;
    }

    const requestUriError = error as RequestUriError;
    if (
        error instanceof URIError
        && (requestUriError.status === 400 || requestUriError.statusCode === 400)
    ) {
        res.status(404).json({
            success: false,
            contractVersion: LEADERBOARD_CONTRACT_VERSION,
            error: 'UNKNOWN_GAME',
        });
        return;
    }

    console.error('Unhandled leaderboard request error', {
        name: error instanceof Error ? error.name : 'UnknownError',
    });
    res.status(500).json({
        success: false,
        contractVersion: LEADERBOARD_CONTRACT_VERSION,
        error: 'SERVER_ERROR',
    });
};
