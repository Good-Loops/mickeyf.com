import assert from 'node:assert/strict';
import test from 'node:test';
import { NextFunction, Request, Response } from 'express';
import { preventSensitiveResponseCaching } from './apiResponseSecurity';

test('API response security middleware applies no-store and continues', () => {
    const headers: Record<string, string> = {};
    let continued = false;
    const response = {
        setHeader(name: string, value: string) {
            headers[name] = value;
            return this;
        },
    } as unknown as Response;

    preventSensitiveResponseCaching(
        {} as Request,
        response,
        (() => {
            continued = true;
        }) as NextFunction
    );

    assert.equal(headers['Cache-Control'], 'no-store');
    assert.equal(continued, true);
});
