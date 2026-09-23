import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express, { NextFunction, Request, Response } from 'express';
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

test('async handler preserves synchronous errors and structured status metadata', async () => {
    for (const failure of [new TypeError('private detail'), { status: 413, type: 'entity.too.large' }]) {
        const forwarded = new Promise<unknown>((resolve) => {
            asyncHandler(() => { throw failure; })(
                {} as Request, {} as Response, resolve as NextFunction
            );
        });
        assert.equal(await forwarded, failure);
    }
});

test('primitive rejections reach the error response instead of continuing routing', async context => {
    const failures = [undefined, null, false, 0, '', 'route', 'router', 'private diagnostic'];
    const logged: unknown[][] = [];
    context.mock.method(console, 'error', (...values: unknown[]) => { logged.push(values); });
    const app = express();
    const router = express.Router();
    router.get('/:index', asyncHandler(req => Promise.reject(failures[Number(req.params.index)])));
    router.use((_req, res) => { res.status(418).json({ error: 'ROUTE_SKIPPED' }); });
    app.use('/failure', router);
    app.use((_req, res) => { res.status(418).json({ error: 'ROUTER_SKIPPED' }); });
    app.use(requestErrorHandler);

    const server = app.listen(0, '127.0.0.1');
    try {
        await once(server, 'listening');
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        for (const [index, failure] of failures.entries()) {
            const response: globalThis.Response = await fetch(`http://127.0.0.1:${address.port}/failure/${index}`, {
                signal: AbortSignal.timeout(5000),
            });
            assert.equal(response.status, 500, `rejection: ${String(failure)}`);
            assert.deepEqual(await response.json(), { error: 'SERVER_ERROR' });
        }
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
    assert.equal(logged.length, failures.length);
    assert.equal(JSON.stringify(logged).includes('private diagnostic'), false);
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
