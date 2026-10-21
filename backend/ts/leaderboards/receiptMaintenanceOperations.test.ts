import assert from 'node:assert/strict';
import test from 'node:test';
import { createPool, PoolConnection } from 'mysql2/promise';
import { ReceiptCleanupConfig } from '../config/receiptCleanupConfig';
import { cleanupSubmissionReceipts, ReceiptCleanupSummary } from './submissionReceiptCleanup';
import { runReceiptCleanup, runReceiptMaintenance } from './receiptMaintenanceOperations';

const config: ReceiptCleanupConfig = {
    databaseOptions: { user: 'receipt_cleanup', database: 'cms' },
    expectedAccount: 'receipt_cleanup@cloudsqlproxy~%',
    expectedServerUuid: '00000000-0000-0000-0000-000000000000',
};
const summary: ReceiptCleanupSummary = { status: 'completed', retentionHours: 24, scannedBatches: 1,
    deleteBatches: 0, deletedReceipts: 0, elapsedMs: 1, backlog: false };

test('receipt configuration failure does not prevent Apple maintenance', async () => {
    const events: Record<string, unknown>[] = [];
    let dispatched = false;
    const code = await runReceiptMaintenance({
        receipt: () => runReceiptCleanup({
            loadConfig: () => { throw new Error('private db credentials'); },
            createPool: () => { throw new Error('must not open DB'); },
            writeEvent: event => { events.push(event); },
        }),
        apple: async () => { dispatched = true; return { status: 'completed' }; },
    });
    assert.equal(code, 1);
    assert.equal(dispatched, true);
    assert.deepEqual(events, [{ severity: 'ERROR', status: 'failed', reason: 'configuration-or-shutdown' }]);
});

test('both operations start independently and the job awaits both before exiting', async () => {
    const events: string[] = [];
    let finishReceipt!: (code: number) => void;
    let finishApple!: (value: { status: 'completed' }) => void;
    let settled = false;
    const running = runReceiptMaintenance({
        receipt: () => { events.push('receipt'); return new Promise(resolve => { finishReceipt = resolve; }); },
        apple: () => { events.push('apple'); return new Promise(resolve => { finishApple = resolve; }); },
    }).then(code => { settled = true; return code; });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ['receipt', 'apple']);
    finishReceipt(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'receipt failure must not interrupt independent Apple cleanup');
    finishApple({ status: 'completed' });
    assert.equal(await running, 1);
});

test('Apple failure does not interrupt pending receipt cleanup', async () => {
    let finishReceipt!: (code: number) => void;
    let settled = false;
    const running = runReceiptMaintenance({
        receipt: () => new Promise(resolve => { finishReceipt = resolve; }),
        apple: async () => ({ status: 'failed', reason: 'deadline' }),
    }).then(code => { settled = true; return code; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    finishReceipt(0);
    assert.equal(await running, 1);
});

test('combined exit preserves backlog failure and allows deliberately disabled Apple dispatch', async () => {
    for (const [receipt, apple, expected] of [
        [0, 'completed', 0], [0, 'disabled', 0], [2, 'completed', 2],
        [2, 'disabled', 2], [0, 'failed', 1], [2, 'failed', 1],
    ] as const) {
        assert.equal(await runReceiptMaintenance({ receipt: async () => receipt,
            apple: async () => ({ status: apple }) }), expected);
    }
});

test('unexpected receipt exception is contained without skipping the other operation', async () => {
    let dispatched = false;
    assert.equal(await runReceiptMaintenance({
        receipt: () => { throw new Error('private synchronous exception'); },
        apple: async () => { dispatched = true; return { status: 'completed' }; },
    }), 1);
    assert.equal(dispatched, true);
    assert.equal(await runReceiptMaintenance({ receipt: async () => 0,
        apple: async () => { throw new Error('private network exception'); } }), 1);
});

test('receipt acquisition timeout remains bounded and Apple completes independently', async () => {
    const events: Record<string, unknown>[] = [];
    let dispatched = false;
    let ended = false;
    const pool = { getConnection: () => new Promise<PoolConnection>(() => undefined),
        end: async () => { ended = true; } } as ReturnType<typeof createPool>;
    const code = await runReceiptMaintenance({
        receipt: () => runReceiptCleanup({ loadConfig: () => config, createPool: () => pool,
            cleanup: (database) => cleanupSubmissionReceipts(database, { maxDurationMs: 5 }),
            writeEvent: event => { events.push(event); },
        }),
        apple: async () => { dispatched = true; return { status: 'completed' }; },
    });
    assert.equal(code, 1);
    assert.equal(dispatched, true);
    assert.equal(ended, true);
    assert.deepEqual(events, [{ severity: 'ERROR', status: 'failed', reason: 'deadline' }]);
});

test('receipt pool shutdown has its own bounded deadline', async () => {
    const events: Record<string, unknown>[] = [];
    const pool = { end: () => new Promise<void>(() => undefined) } as ReturnType<typeof createPool>;
    assert.equal(await runReceiptCleanup({ loadConfig: () => config, createPool: () => pool,
        cleanup: async () => summary, shutdownDurationMs: 5, writeEvent: event => { events.push(event); },
    }), 1);
    assert.equal(events[0].status, 'completed');
    assert.deepEqual(events[1], { severity: 'ERROR', status: 'failed', reason: 'shutdown' });
});
