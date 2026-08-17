import { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';

type AsyncRequestHandler = (
    req: Request,
    res: Response,
    next: NextFunction
) => unknown | Promise<unknown>;

type RequestError = Error & {
    status?: number;
    statusCode?: number;
    type?: string;
};

export function asyncHandler(handler: AsyncRequestHandler): RequestHandler {
    return (req, res, next) => {
        void Promise.resolve()
            .then(() => handler(req, res, next))
            .catch(next);
    };
}

export const notFoundHandler: RequestHandler = (_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND' });
};

export const requestErrorHandler: ErrorRequestHandler = (error: RequestError, _req, res, next) => {
    if (res.headersSent) {
        next(error);
        return;
    }

    const candidateStatus = error.status ?? error.statusCode;
    const status = Number.isSafeInteger(candidateStatus)
        && (candidateStatus as number) >= 400
        && (candidateStatus as number) < 500
        ? candidateStatus as number
        : 500;

    if (status === 413 || error.type === 'entity.too.large') {
        res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
        return;
    }

    if (status < 500) {
        res.status(status).json({ error: 'INVALID_REQUEST' });
        return;
    }

    console.error('Unhandled request error', {
        name: error instanceof Error ? error.name : 'UnknownError',
    });
    res.status(500).json({ error: 'SERVER_ERROR' });
};
