import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolConnection, QueryOptions } from 'mysql2/promise';
import { AppleTokenClientError } from '../auth/appleTokenClient';
import type { StoredAppleToken } from './appleTokenRepository';
import { APPLE_REVOCATION_BATCH_SIZE, AppleTokenRevocationError, createAppleTokenRevocationWorker } from './appleTokenRevocation';

const clientId = 'com.example.apple';
const DAY = 86_400_000;
type Row = StoredAppleToken & { attempt_count: number; pending: boolean; next: number; deadline: number };
function row(overrides: Partial<Row> = {}): Row {
    return { token_id: randomUUID(), account_uuid: randomUUID(), client_id: clientId,
        encrypted_token: Buffer.from('synthetic-encrypted-token'), attempt_count: 0,
        pending: true, next: 0, deadline: 7 * DAY, ...overrides };
}
type Options = {
    lock?: unknown; unlock?: unknown; failQuery?: RegExp; failAcquire?: boolean; failRelease?: boolean;
    decrypt?: (row: StoredAppleToken) => string; revoke?: (token: string) => Promise<void>;
};

function fixture(initial: Row[], options: Options = {}) {
    const rows = initial.map(item => ({ ...item }));
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const events: string[] = [];
    const clock = { now: 1_000 };
    const state = { acquired: 0, released: 0, destroyed: 0, socketDestroyed: 0, lockHeld: false };
    const due = (item: Row) => item.pending && item.next <= clock.now && item.deadline > clock.now;
    const remove = (items: Row[]) => { for (const item of items) rows.splice(rows.indexOf(item), 1); };
    const connection = {
        connection: { stream: { destroy() { state.socketDestroyed++; } } },
        async query(input: QueryOptions, values: unknown[] = []) {
            const sql = input.sql.replace(/\s+/gu, ' ').trim();
            queries.push({ sql, values });
            assert.equal(input.timeout, 10_000);
            if (options.failQuery?.test(sql)) throw new Error('private SQL parameters and credentials');
            const limit = Number(sql.match(/LIMIT (\d+)/u)?.[1]);
            if (sql.includes('GET_LOCK')) {
                events.push('lock');
                const acquired = options.lock === undefined ? 1 : options.lock;
                state.lockHeld = acquired === 1;
                return [[{ acquired }], []];
            }
            assert.equal(state.lockHeld, true, 'all queue work requires the named lock');
            if (sql.includes('RELEASE_LOCK')) {
                events.push('unlock');
                const released = options.unlock === undefined ? 1 : options.unlock;
                if (released === 1) state.lockHeld = false;
                return [[{ released }], []];
            }
            if (sql === 'SET SESSION autocommit = 1') { events.push('autocommit'); return [{}, []]; }
            if (sql.startsWith('UPDATE')) {
                events.push('claim');
                assert.match(sql, /SET attempt_count = LEAST\(attempt_count \+ 1, 4294967295\), next_attempt_at = LEAST\(retention_deadline, TIMESTAMPADD\(SECOND, \?, UTC_TIMESTAMP\(6\)\)\)/u);
                const candidate = rows.find(item => item.token_id === values[1] && due(item));
                if (!candidate) return [{ affectedRows: 0 }, []];
                candidate.attempt_count = Math.min(candidate.attempt_count + 1, 4_294_967_295);
                candidate.next = Math.min(candidate.deadline, clock.now + Number(values[0]) * 1_000);
                return [{ affectedRows: 1 }, []];
            }
            if (sql.startsWith('DELETE') && sql.includes('WHERE token_id = ?')) {
                events.push('delete');
                const deleted = rows.filter(item => item.token_id === values[0] && item.pending);
                remove(deleted); return [{ affectedRows: deleted.length }, []];
            }
            if (sql.startsWith('DELETE')) {
                events.push('purge');
                const expired = rows.filter(item => item.pending && item.deadline <= clock.now).slice(0, limit);
                remove(expired); return [{ affectedRows: expired.length }, []];
            }
            if (sql.startsWith('SELECT 1')) {
                return [rows.filter(item => item.pending && (item.deadline <= clock.now || due(item))).slice(0, 1), []];
            }
            assert.match(sql, /^SELECT token_id/u);
            events.push('select');
            return [rows.filter(due).slice(0, limit).map(item => ({ ...item })), []];
        },
        release() { state.released++; if (options.failRelease) throw new Error('private pool failure'); },
        destroy() { state.destroyed++; state.lockHeld = false; },
    } as unknown as PoolConnection;
    const database = { async getConnection() {
        state.acquired++;
        if (options.failAcquire) throw new Error('private database password');
        return connection;
    } } as Pick<Pool, 'getConnection'>;
    const worker = createAppleTokenRevocationWorker({ database, clientId,
        vault: { decrypt(item) { events.push('decrypt'); return options.decrypt?.(item) ?? 'synthetic-refresh-token'; } },
        appleTokens: { async revoke(token) { events.push('revoke'); await options.revoke?.(token); } },
    });
    return { worker, rows, state, events, queries, clock };
}

test('construction is inert; explicit drain serializes revocation outside transactions and returns only counters', async () => {
    const f = fixture([row(), row(), row({ pending: false })]);
    assert.equal(f.state.acquired, 0);
    const summary = await f.worker.drain();
    assert.deepEqual(summary, { status: 'completed', selected: 2, revoked: 2, retried: 0, expired: 0 });
    assert.equal(Object.isFrozen(summary), true);
    assert.deepEqual(f.events, ['lock', 'autocommit', 'purge', 'select', 'claim', 'decrypt', 'revoke', 'delete',
        'claim', 'decrypt', 'revoke', 'delete', 'purge', 'unlock']);
    assert.equal(f.rows.length, 1);
    assert.equal(f.rows[0].pending, false);
    assert.deepEqual(f.state, { acquired: 1, released: 1, destroyed: 0, socketDestroyed: 0, lockHeld: false });
    assert.ok(f.queries.every(({ sql }) => !/START TRANSACTION|COMMIT|ROLLBACK|users|account_provider_identities/u.test(sql)));
    assert.match(f.queries[0].sql, /GET_LOCK\(CONCAT\('mickeyf:apple-revocation:', LEFT\(SHA2\(DATABASE\(\), 256\), 16\)\), 0\)/u);
    assert.ok(f.queries.every(({ values }) => !values.includes('synthetic-refresh-token')));
});

test('unavailable and invalid-grant responses retry with bounded exponential backoff without extending retention', async () => {
    for (const code of ['UNAVAILABLE', 'INVALID_GRANT'] as const) {
        const f = fixture([row()], { revoke: async () => { throw new AppleTokenClientError(code); } });
        for (const seconds of [60, 120, 240, 480, 960, 1920, 3600, 3600]) {
            const before = f.rows[0].attempt_count;
            const summary = await f.worker.drain();
            assert.deepEqual(summary, { status: 'completed', selected: 1, revoked: 0, retried: 1, expired: 0 });
            assert.equal(f.rows[0].attempt_count, before + 1);
            assert.equal(f.rows[0].next, f.clock.now + seconds * 1_000);
            assert.equal(f.rows[0].deadline, 7 * DAY);
            f.clock.now = f.rows[0].next;
        }
        assert.equal(f.events.includes('delete'), false);
    }
});

test('expired tokens purge before Apple is contacted, and failure cannot extend the exact retention deadline', async () => {
    const f = fixture([row({ deadline: 1_000 }), row({ deadline: 2_000 })], {
        revoke: async () => {
            assert.equal(f.rows.length, 1, 'expired material was already purged');
            assert.equal(f.rows[0].next, 2_000, 'next retry is capped at retention deadline');
            f.clock.now = 2_000;
            throw new Error('private upstream outage');
        },
    });
    assert.deepEqual(await f.worker.drain(), { status: 'completed', selected: 1, revoked: 0, retried: 1, expired: 2 });
    assert.equal(f.rows.length, 0);
});

test('later candidates are rechecked for expiry after each serial Apple call', async () => {
    const f = fixture([row(), row({ deadline: 2_000 })], { revoke: async () => { f.clock.now = 2_000; } });
    assert.deepEqual(await f.worker.drain(), { status: 'completed', selected: 2, revoked: 1, retried: 0, expired: 1 });
    assert.equal(f.events.filter(event => event === 'revoke').length, 1);
});

test('wrong clients and decryption errors retain encrypted work without passing anything to Apple', async () => {
    for (const failure of ['client', 'decrypt']) {
        const f = fixture([row({ client_id: failure === 'client' ? 'wrong.client' : clientId })], {
            decrypt: () => { throw new Error('private decryption key or token'); },
            revoke: async () => assert.fail('invalid stored proof cannot reach Apple'),
        });
        assert.deepEqual(await f.worker.drain(), { status: 'completed', selected: 1, revoked: 0, retried: 1, expired: 0 });
        assert.equal(f.rows.length, 1);
        assert.equal(f.rows[0].attempt_count, 1);
        assert.equal(f.events.includes('decrypt'), failure === 'decrypt');
    }
});

test('a busy lock performs no queue or Apple work and returns its connection', async () => {
    const f = fixture([row()], { lock: 0 });
    assert.deepEqual(await f.worker.drain(), { status: 'busy', selected: 0, revoked: 0, retried: 0, expired: 0 });
    assert.deepEqual(f.events, ['lock']);
    assert.equal(f.state.released, 1);
    assert.equal(f.state.destroyed, 0);
});

test('bounded passes report remaining due work, including excess expired material', async () => {
    const f = fixture([row(), row(), row()]);
    assert.deepEqual(await f.worker.drain({ batchSize: 1 }), { status: 'backlog', selected: 1, revoked: 1, retried: 0, expired: 0 });
    const expired = fixture(Array.from({ length: 3 }, () => row({ deadline: 1_000 })));
    assert.deepEqual(await expired.worker.drain({ batchSize: 1 }), { status: 'backlog', selected: 0, revoked: 0, retried: 0, expired: 2 });
});

test('database, lock-release and pool failures are sanitized and destroy uncertain connections', async () => {
    const failures: Options[] = [
        ...[/GET_LOCK/u, /SET SESSION/u, /^SELECT token_id/u, /^UPDATE/u, /^DELETE.*WHERE token_id/u, /RELEASE_LOCK/u]
            .map(failQuery => ({ failQuery })),
        { lock: null }, { unlock: 0 }, { failRelease: true }, { failAcquire: true },
    ];
    for (const options of failures) {
        const f = fixture([row()], options);
        await assert.rejects(f.worker.drain(), error => {
            assert.ok(error instanceof AppleTokenRevocationError);
            assert.doesNotMatch(error.message + JSON.stringify(error), /private|password|token_id|synthetic-refresh/u);
            assert.equal('cause' in error, false);
            return true;
        });
        assert.equal(f.state.destroyed, options.failAcquire ? 0 : 1);
        assert.equal(f.state.socketDestroyed, options.failAcquire ? 0 : 1);
        assert.equal(f.state.released, options.failRelease ? 1 : 0);
    }
});

test('invalid limits and malformed queue counters fail without an Apple request', async () => {
    const f = fixture([]);
    for (const batchSize of [0, -1, 1.5, NaN, APPLE_REVOCATION_BATCH_SIZE + 1]) {
        await assert.rejects(f.worker.drain({ batchSize }), AppleTokenRevocationError);
    }
    assert.equal(f.state.acquired, 0);
    for (const attempt_count of [-1, 1.5, 4_294_967_296]) {
        const malformed = fixture([row({ attempt_count })]);
        await assert.rejects(malformed.worker.drain(), error => error instanceof AppleTokenRevocationError && error.code === 'INVALID_RESULT');
        assert.equal(malformed.events.includes('revoke'), false);
        assert.equal(malformed.state.destroyed, 1);
    }
});
