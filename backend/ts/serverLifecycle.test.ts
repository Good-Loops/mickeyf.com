import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, get, type RequestListener } from 'node:http';
import test, { type TestContext } from 'node:test';
import { runHttpServer } from './serverLifecycle';

function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(context: TestContext, handler: RequestListener = (_request, response) => response.end('ready')) {
    const server = createServer(handler);
    const events: string[] = [];
    const errors: unknown[][] = [];
    const exits: number[] = [];
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });
    const processControl = Object.assign(new EventEmitter(), {
        exit(code: number) { exits.push(code); resolveExit(code); },
    });
    context.mock.method(console, 'error', (...values: unknown[]) => { errors.push(values); });
    context.after(async () => {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    });
    const options = {
        server, port: 0, processControl, shutdownTimeoutMs: 500,
        prepare: async () => { events.push('prepared'); },
        waitForHandlers: async () => { events.push('handlers-drained'); },
        closeDatabase: async () => { events.push('database-closed'); },
        onListening: () => { events.push('listening'); },
    };
    const request = () => {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const client = get({ hostname: '127.0.0.1', port: address.port, agent: false });
        client.on('error', () => undefined);
        return client;
    };
    return { server, events, errors, exits, exited, processControl, options, request };
}

test('startup waits for preparation; SIGINT drains and releases signal listeners', { timeout: 2_000 }, async context => {
    const f = fixture(context);
    const preparation = gate();
    const started = runHttpServer({ ...f.options, prepare: () => preparation.promise });
    await tick();
    assert.equal(f.server.listening, false);
    assert.deepEqual(f.events, []);
    preparation.release();
    await started;
    assert.equal(f.server.listening, true);
    assert.deepEqual(f.events, ['listening']);
    f.processControl.emit('SIGINT');
    assert.equal(await f.exited, 0);
    assert.deepEqual(f.events, ['listening', 'handlers-drained', 'database-closed']);
    assert.equal(f.processControl.listenerCount('SIGINT'), 0);
    assert.equal(f.processControl.listenerCount('SIGTERM'), 0);
});

test('preparation failure closes the database without exposing diagnostics', { timeout: 2_000 }, async context => {
    const f = fixture(context);
    await runHttpServer({ ...f.options, prepare: async () => { throw new Error('private database credentials'); } });
    assert.equal(await f.exited, 1);
    assert.equal(f.server.listening, false);
    assert.equal(f.events.filter(event => event === 'database-closed').length, 1);
    assert.ok(f.errors.length > 0);
    assert.equal(JSON.stringify(f.errors).includes('private database credentials'), false);
});

test('asynchronous bind failure closes the database and exits unsuccessfully', { timeout: 2_000 }, async context => {
    const blocker = createServer();
    blocker.listen(0);
    await once(blocker, 'listening');
    context.after(() => new Promise<void>(resolve => blocker.close(() => resolve())));
    const address = blocker.address();
    assert.ok(address && typeof address !== 'string');
    const f = fixture(context);
    await runHttpServer({ ...f.options, port: address.port });
    assert.equal(await f.exited, 1);
    assert.equal(f.events.includes('listening'), false);
    assert.equal(f.events.filter(event => event === 'database-closed').length, 1);
});

test('signals during preparation wait for it, never listen, and clean up once', { timeout: 2_000 }, async context => {
    const f = fixture(context);
    const preparation = gate();
    const started = runHttpServer({ ...f.options, prepare: () => preparation.promise });
    f.processControl.emit('SIGTERM');
    f.processControl.emit('SIGINT');
    await tick();
    assert.equal(f.events.length, 0);
    assert.equal(f.exits.length, 0);
    preparation.release();
    await started;
    assert.equal(await f.exited, 0);
    assert.equal(f.server.listening, false);
    assert.equal(f.events.includes('listening'), false);
    assert.equal(f.events.filter(event => event === 'database-closed').length, 1);
    assert.deepEqual(f.exits, [0]);
});

test('SIGTERM waits for HTTP responses and handler completion before closing the database', { timeout: 2_000 }, async context => {
    const accepted = gate();
    const responseReady = gate();
    const handlers = gate();
    const f = fixture(context, (_request, response) => {
        accepted.release();
        void responseReady.promise.then(() => response.end('complete'));
    });
    await runHttpServer({ ...f.options, waitForHandlers: () => handlers.promise });
    const client = f.request();
    const responseFinished = new Promise<void>(resolve => client.once('response', response => {
        response.resume(); response.once('end', resolve);
    }));
    await accepted.promise;
    f.processControl.emit('SIGTERM');
    f.processControl.emit('SIGINT');
    await tick();
    assert.equal(f.server.listening, false);
    assert.equal(f.events.includes('database-closed'), false);
    responseReady.release();
    await responseFinished;
    await tick();
    assert.equal(f.events.includes('database-closed'), false);
    handlers.release();
    assert.equal(await f.exited, 0);
    assert.equal(f.events.filter(event => event === 'database-closed').length, 1);
    assert.deepEqual(f.exits, [0]);
});

test('a disconnected client does not release unfinished application work', { timeout: 2_000 }, async context => {
    const accepted = gate();
    const handlers = gate();
    const f = fixture(context, () => accepted.release());
    await runHttpServer({ ...f.options, waitForHandlers: () => handlers.promise });
    const client = f.request();
    await accepted.promise;
    client.destroy();
    f.processControl.emit('SIGTERM');
    await tick();
    assert.equal(f.events.includes('database-closed'), false);
    assert.deepEqual(f.exits, []);
    handlers.release();
    assert.equal(await f.exited, 0);
    assert.equal(f.events.filter(event => event === 'database-closed').length, 1);
});

test('shutdown deadline destroys connections without closing the database beneath held handlers', { timeout: 2_000 }, async context => {
    const accepted = gate();
    const handlers = gate();
    const f = fixture(context, () => accepted.release());
    await runHttpServer({ ...f.options, shutdownTimeoutMs: 25, waitForHandlers: () => handlers.promise });
    const client = f.request();
    const disconnected = new Promise<void>(resolve => client.once('close', resolve));
    await accepted.promise;
    f.processControl.emit('SIGTERM');
    assert.equal(await f.exited, 1);
    await disconnected;
    assert.equal(f.events.includes('database-closed'), false);
    handlers.release();
});

test('database shutdown rejection remains a generic unsuccessful exit', { timeout: 2_000 }, async context => {
    const f = fixture(context);
    await runHttpServer({ ...f.options, closeDatabase: async () => { throw new Error('private driver detail'); } });
    f.processControl.emit('SIGTERM');
    assert.equal(await f.exited, 1);
    assert.ok(f.errors.length > 0);
    assert.equal(JSON.stringify(f.errors).includes('private driver detail'), false);
});

test('database shutdown that never settles is bounded by the same deadline', { timeout: 2_000 }, async context => {
    const f = fixture(context);
    const closing = gate();
    await runHttpServer({ ...f.options, shutdownTimeoutMs: 25, closeDatabase: () => closing.promise });
    f.processControl.emit('SIGTERM');
    assert.equal(await f.exited, 1);
    closing.release();
});
