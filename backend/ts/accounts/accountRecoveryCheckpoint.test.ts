import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { establishRecoveryCheckpoint, readRecoveryCheckpoint, RecoveryCheckpointUnavailableError, verifyCheckpointRecoveryCoverage } from './accountRecoveryCheckpoint';

const pins = { database: 'synthetic', currentUser: 'ops@localhost', serverUuid: '553b99f4-10f1-46e8-a2d0-003445c10bed',
    lineage: 'ba535d80-9695-4147-a8af-62c645af2ee6', minimumEpoch: '6' };
const row = { databaseName: pins.database, currentUser: pins.currentUser, serverUuid: pins.serverUuid,
    lineageId: pins.lineage, checkpointEpoch: '6' };
const connection = (rows: unknown) => ({ async query() { return [rows, []]; } }) as unknown as Pick<PoolConnection, 'query'>;

test('reads the checkpoint from the pinned database and accepts a newer epoch', async () => {
    assert.deepEqual(await readRecoveryCheckpoint(connection([row]), pins), { lineage: pins.lineage, epoch: '6' });
    assert.equal((await readRecoveryCheckpoint(connection([{ ...row, checkpointEpoch: '7' }]), pins)).epoch, '7');
});

test('rejects older, missing, ambiguous and unrelated restored databases', async () => {
    const cases = [[], [row, row], [{ ...row, checkpointEpoch: '5' }], [{ ...row, checkpointEpoch: 6 }],
        [{ ...row, checkpointEpoch: '06' }], [{ ...row, checkpointEpoch: '18446744073709551616' }],
        [{ ...row, databaseName: 'other' }], [{ ...row, currentUser: 'other@localhost' }],
        [{ ...row, serverUuid: '653b99f4-10f1-46e8-a2d0-003445c10bed' }],
        [{ ...row, lineageId: 'ca535d80-9695-4147-a8af-62c645af2ee6' }]];
    for (const rows of cases) await assert.rejects(readRecoveryCheckpoint(connection(rows), pins), RecoveryCheckpointUnavailableError);
});

test('refuses a zero floor and sanitizes database errors', async () => {
    await assert.rejects(readRecoveryCheckpoint(connection([row]), { ...pins, minimumEpoch: '0' }), RecoveryCheckpointUnavailableError);
    const unavailable = { async query() { throw new Error('private SQL connection detail'); } } as unknown as Pick<PoolConnection, 'query'>;
    await assert.rejects(readRecoveryCheckpoint(unavailable, pins), error => {
        assert.ok(error instanceof RecoveryCheckpointUnavailableError);
        assert.doesNotMatch(String(error), /private SQL/u);
        return true;
    });
});

function transactionFixture(options: { commitFails?: boolean; postCommitFails?: boolean; initialEpoch?: string } = {}) {
    const calls: string[] = [];
    let epoch = options.initialEpoch ?? '0';
    const fake = {
        async beginTransaction() { calls.push('begin'); },
        async commit() { calls.push('commit'); if (options.commitFails) throw new Error('uncertain'); },
        async rollback() { calls.push('rollback'); },
        destroy() { calls.push('destroy'); },
        async query(input: { sql: string }) {
            if (input.sql.includes('FROM account_recovery_checkpoint')) {
                assert.match(input.sql, /FOR UPDATE/u);
                calls.push('read'); return [[{ ...row, checkpointEpoch: epoch }], []];
            }
            if (input.sql.includes('UPDATE account_recovery_checkpoint')) {
                calls.push('update'); epoch = String(BigInt(epoch) + BigInt(1)); return [{ affectedRows: 1 }, []];
            }
            calls.push('clock');
            if (options.postCommitFails) throw new Error('private clock error');
            return [[{ ...row, nowUtc: '2026-11-05T12:00:00.000000Z' }], []];
        },
    };
    return { calls, connection: fake as unknown as Pick<PoolConnection, 'query' | 'beginTransaction' | 'commit' | 'rollback' | 'destroy'> };
}

test('advances the checkpoint only after the batch verifier, then obtains a post-commit database time', async () => {
    const fixture = transactionFixture();
    const result = await establishRecoveryCheckpoint(fixture.connection, { ...pins, minimumEpoch: '0' }, async () => {
        fixture.calls.push('verify-effects'); return true;
    });
    assert.deepEqual(result, { lineage: pins.lineage, epoch: '1', committedBefore: '2026-11-05T12:00:00.000000Z' });
    assert.deepEqual(fixture.calls, ['begin', 'read', 'verify-effects', 'update', 'read', 'commit', 'clock']);
});

test('failed effect verification rolls back; uncertain commits or post-commit reads never authorize cleanup', async () => {
    const rejected = transactionFixture();
    await assert.rejects(establishRecoveryCheckpoint(rejected.connection, { ...pins, minimumEpoch: '0' }, async () => false), RecoveryCheckpointUnavailableError);
    assert.deepEqual(rejected.calls, ['begin', 'read', 'rollback']);
    for (const options of [{ commitFails: true }, { postCommitFails: true }]) {
        const fixture = transactionFixture(options);
        await assert.rejects(establishRecoveryCheckpoint(fixture.connection, { ...pins, minimumEpoch: '0' }, async () => true), RecoveryCheckpointUnavailableError);
        assert.equal(fixture.calls.at(-1), 'destroy');
        assert.equal(fixture.calls.includes('rollback'), false);
    }
    const stale = transactionFixture({ initialEpoch: '5' });
    await assert.rejects(establishRecoveryCheckpoint(stale.connection, pins, async () => { throw new Error('must not run'); }), RecoveryCheckpointUnavailableError);
    assert.deepEqual(stale.calls, ['begin', 'read', 'rollback']);
});

test('requires a recoverable provider point after the committed checkpoint on the pinned instance', () => {
    const checkpoint = { lineage: pins.lineage, epoch: '6', committedBefore: '2026-11-05T12:00:00.000000Z' };
    const inventory = { project: 'noted-reef-387021', instance: 'cms-mickeyf', backupCount: 9,
        latestRecoveryAt: '2026-11-05T12:00:00.000000Z', observedAt: '2026-11-05T12:05:00.000000Z' };
    const expected = { project: inventory.project, instance: inventory.instance };
    assert.doesNotThrow(() => verifyCheckpointRecoveryCoverage(checkpoint, inventory, expected));
    for (const change of [{ latestRecoveryAt: '2026-11-05T11:59:59.999999Z' }, { backupCount: 0 },
        { instance: 'other' }, { latestRecoveryAt: '2026-11-05T12:06:00.000000Z' }]) {
        assert.throws(() => verifyCheckpointRecoveryCoverage(checkpoint, { ...inventory, ...change }, expected), RecoveryCheckpointUnavailableError);
    }
});
