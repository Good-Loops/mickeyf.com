import { RequestHandler } from 'express';

/** Prevent browsers and intermediaries from retaining API/auth responses. */
export const preventSensitiveResponseCaching: RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
};
