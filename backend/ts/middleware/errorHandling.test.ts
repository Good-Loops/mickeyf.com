import assert from 'node:assert/strict';
import test from 'node:test';
import { NextFunction, Request, Response } from 'express';
import { asyncHandler, requestErrorHandler } from './errorHandling';

function responseRecorder() {
    const state: { status?: number; body?: unknown } = {};
    const response = {
        headersSent: false,
        status(status: number) {
            state.status = status;
            return this;
        },
        json(body: unknown) {
            state.body = body;
            return this;
        },
    } as unknown as Response;
    return { response, state };
}

test('async handler forwards rejected controller work to Express', async () => {
    const failure = new Error('database detail that must not become a response');
    const forwarded = new Promise<unknown>((resolve) => {
        asyncHandler(async () => {
            throw failure;
        })({} as Request, {} as Response, resolve as NextFunction);
    });

    assert.equal(await forwarded, failure);
});

test('central handler returns generic server errors without sensitive details', () => {
    const { response, state } = responseRecorder();
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
        requestErrorHandler(
            new Error('sensitive database host and query'),
            {} as Request,
            response,
            (() => undefined) as NextFunction
        );
    } finally {
        console.error = originalConsoleError;
    }

    assert.equal(state.status, 500);
    assert.deepEqual(state.body, { error: 'SERVER_ERROR' });
    assert.equal(JSON.stringify(state.body).includes('sensitive'), false);
});

test('oversized JSON receives a stable 413 response', () => {
    const { response, state } = responseRecorder();
    const error = Object.assign(new Error('too large'), {
        status: 413,
        type: 'entity.too.large',
    });

    requestErrorHandler(
        error,
        {} as Request,
        response,
        (() => undefined) as NextFunction
    );

    assert.equal(state.status, 413);
    assert.deepEqual(state.body, { error: 'PAYLOAD_TOO_LARGE' });
});
