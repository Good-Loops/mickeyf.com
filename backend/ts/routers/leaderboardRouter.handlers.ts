import { ErrorRequestHandler } from 'express';
import { LEADERBOARD_CONTRACT_VERSION } from '../leaderboards/leaderboardContract';

type RequestUriError = URIError & {
    status?: number;
    statusCode?: number;
};

/** Converts unexpected failures inside the generic router to its versioned DTO. */
export const leaderboardRequestErrorHandler: ErrorRequestHandler = (
    error,
    _req,
    res,
    next
) => {
    if (res.headersSent) {
        next(error);
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
