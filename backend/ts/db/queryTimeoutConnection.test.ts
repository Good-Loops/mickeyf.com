import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import test from 'node:test';
import mysql from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { guardConnectionQueries } from './queryTimeoutConnection';

test('a real mysql2 stalled query discards its pool slot and cannot queue rollback behind it', async () => {
    const sockets = new Set<Socket>();
    const received: string[] = [];
    let connections = 0;
    // Scripted loopback protocol peer; no MySQL service, data or environment credentials.
    const server = createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        const peer = mysql.createConnection({ stream: socket, isServer: true });
        peer.on('error', () => undefined);
        // mysql2's low-level server helper leaves packet sequencing to its peer.
        const resetSequence = () => (peer as unknown as { _resetSequenceId(): void })._resetSequenceId();
        peer.serverHandshake({ protocolVersion: 10, serverVersion: '8.0.31-fixture',
            connectionId: ++connections, statusFlags: 2, characterSet: 45, capabilityFlags: 512,
            authCallback: (_auth: unknown, done: () => void) => { done(); resetSequence(); } });
        peer.on('query', (sql: string) => {
            received.push(sql);
            if (sql !== 'SELECT stalled') { peer.writeOk(); resetSequence(); }
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const pool = mysql.createPool({ host: '127.0.0.1', port: (server.address() as AddressInfo).port,
        user: 'fixture', connectionLimit: 1, connectTimeout: 1_000 }).promise();
    let raw: PoolConnection | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
        raw = await pool.getConnection();
        const guarded = guardConnectionQueries(raw);
        await assert.rejects(guarded.query({ sql: 'SELECT stalled', timeout: 25 }), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' });
        assert.equal((raw as unknown as { connection: { stream: { destroyed: boolean } } }).connection.stream.destroyed, true);
        const rollback = guarded.rollback().then(() => 'succeeded', () => 'rejected');
        const result = await Promise.race([rollback, new Promise<string>(resolve => {
            watchdog = setTimeout(() => resolve('stalled'), 250);
        })]);
        assert.equal(result, 'rejected', 'cleanup must settle without waiting on the stalled protocol command');
        guarded.release();
        const replacement = await pool.getConnection();
        try {
            assert.notEqual(replacement.threadId, raw.threadId, 'the timed-out connection must not return to the pool');
            await replacement.query({ sql: 'SELECT usable', timeout: 500 });
        } finally { replacement.release(); }
        assert.deepEqual(received, ['SELECT stalled', 'SELECT usable']);
    } finally {
        if (watchdog) clearTimeout(watchdog);
        raw?.destroy();
        for (const socket of sockets) socket.destroy();
        await pool.end();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});

test('a teardown failure still closes the socket and preserves the original timeout', async () => {
    const events: string[] = [];
    const failure = Object.assign(new Error('fixture timeout'), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' });
    const connection = guardConnectionQueries({
        async query() { throw failure; },
        destroy() { events.push('destroy'); throw new Error('private driver teardown'); },
        connection: { stream: { destroy() { events.push('socket-destroy'); } } },
        release() { assert.fail('a discarded session cannot be returned to the pool'); },
    } as unknown as PoolConnection);
    await assert.rejects(connection.query('fixture'), error => error === failure);
    connection.destroy();
    connection.release();
    assert.deepEqual(events, ['destroy', 'socket-destroy']);
});

test('query, execute and transaction helpers discard before exposing timeout failures', async () => {
    for (const command of ['query', 'execute', 'beginTransaction', 'commit', 'rollback'] as const) {
        const events: string[] = [];
        const failure = Object.assign(new Error('fixture timeout'), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' });
        const raw = {
            [command]: async () => { events.push(command); throw failure; },
            destroy() { events.push('destroy'); }, release() { events.push('release'); },
        } as unknown as PoolConnection;
        const connection = guardConnectionQueries(raw);
        await assert.rejects(Reflect.apply(connection[command], connection, []), error => {
            assert.deepEqual(events, [command, 'destroy']);
            return error === failure;
        });
        await assert.rejects(connection.query('must not run'), /no longer available/);
        connection.destroy();
        connection.release();
        assert.deepEqual(events, [command, 'destroy']);
    }
});

test('a healthy borrowed connection keeps its receiver, returns once and rejects use after release', async () => {
    const result = [[{ value: 1 }], []];
    let releases = 0;
    const raw = {
        threadId: 42,
        async query() { assert.equal(this, raw); return result; },
        release() { assert.equal(this, raw); releases += 1; },
        destroy() { assert.fail('a returned connection must not be destroyed later'); },
    } as unknown as PoolConnection;
    const connection = guardConnectionQueries(raw);
    assert.equal(connection.threadId, 42);
    assert.equal(await connection.query('fixture'), result);
    connection.release();
    connection.release();
    connection.destroy();
    await assert.rejects(connection.query('too late'), /no longer available/);
    assert.equal(releases, 1);
});

test('ordinary SQL errors remain available for rollback while timed-out commands discard once', async () => {
    for (const code of ['ER_DUP_ENTRY', 'ER_LOCK_WAIT_TIMEOUT', 'PROTOCOL_SEQUENCE_TIMEOUT']) {
        const events: string[] = [];
        const failure = Object.assign(new Error('fixture SQL failure'), { code });
        const raw = {
            async query() { events.push('query'); throw failure; },
            async rollback() { events.push('rollback'); },
            destroy() { events.push('destroy'); }, release() { events.push('release'); },
        } as unknown as PoolConnection;
        const connection = guardConnectionQueries(raw);
        await assert.rejects(connection.query('fixture'), error => error === failure);
        if (code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
            await assert.rejects(connection.rollback());
            connection.destroy();
            connection.release();
            assert.deepEqual(events, ['query', 'destroy']);
        } else {
            await connection.rollback();
            connection.release();
            assert.deepEqual(events, ['query', 'rollback', 'release']);
        }
    }
});
