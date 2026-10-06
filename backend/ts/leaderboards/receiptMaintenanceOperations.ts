import { createPool } from 'mysql2/promise';
import { loadReceiptCleanupConfig } from '../config/receiptCleanupConfig';
import { verifyReceiptCleanupConnection } from '../security/receiptCleanupGrantManifest';
import { cleanupSubmissionReceipts, ReceiptCleanupError } from './submissionReceiptCleanup';
import { dispatchAppleMaintenance, AppleMaintenanceDispatchResult } from './appleMaintenanceDispatch';

type ReceiptDependencies = Readonly<{
    createPool?: typeof createPool;
    loadConfig?: typeof loadReceiptCleanupConfig;
    cleanup?: typeof cleanupSubmissionReceipts;
    writeEvent?: (event: Record<string, unknown>) => void;
    shutdownDurationMs?: number;
}>;

/** Import-safe receipt-only operation; its SQL identity and grants are unchanged. */
export async function runReceiptCleanup(dependencies: ReceiptDependencies = {}): Promise<number> {
    const writeEvent = dependencies.writeEvent ?? ((event) => {
        process.stdout.write(`${JSON.stringify({ component: 'submission-receipt-cleanup', ...event })}\n`);
    });
    let pool: ReturnType<typeof createPool> | undefined;
    let exitCode = 1;
    try {
        const config = (dependencies.loadConfig ?? loadReceiptCleanupConfig)();
        pool = (dependencies.createPool ?? createPool)(config.databaseOptions);
        const summary = await (dependencies.cleanup ?? cleanupSubmissionReceipts)(pool, {
            verifyConnection: (connection) => verifyReceiptCleanupConnection(
                { query: (sql) => connection.query({ sql, timeout: 10_000 }) },
                config.databaseOptions.database!,
                { user: config.databaseOptions.user!, host: config.expectedAccount.split('@')[1] },
                config.expectedServerUuid
            ),
        });
        exitCode = summary.backlog ? 2 : 0;
        writeEvent({ severity: summary.backlog ? 'ERROR' : 'INFO', ...summary });
    } catch (error) {
        writeEvent({ severity: 'ERROR', status: 'failed',
            reason: error instanceof ReceiptCleanupError ? error.code : 'configuration-or-shutdown' });
    } finally {
        if (pool) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const durationMs = dependencies.shutdownDurationMs ?? 5_000;
                if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 5_000) {
                    throw new Error('Invalid shutdown duration.');
                }
                await Promise.race([
                    pool.end(),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(() => reject(new Error('shutdown')), durationMs);
                    }),
                ]);
            } catch {
                exitCode = 1;
                writeEvent({ severity: 'ERROR', status: 'failed', reason: 'shutdown' });
            } finally {
                if (timer) clearTimeout(timer);
            }
        }
    }
    return exitCode;
}

/** A receipt outage must not skip Apple's independent retry/expiry maintenance. */
export async function runReceiptMaintenance(operations: Readonly<{
    receipt?: () => Promise<number>;
    apple?: () => Promise<AppleMaintenanceDispatchResult>;
}> = {}): Promise<number> {
    const [receipt, apple] = await Promise.allSettled([
        Promise.resolve().then(() => (operations.receipt ?? runReceiptCleanup)()),
        Promise.resolve().then(() => (operations.apple ?? dispatchAppleMaintenance)()),
    ]);
    if (receipt.status === 'rejected' || apple.status === 'rejected'
        || receipt.value === 1 || apple.value.status === 'failed') return 1;
    return receipt.value === 0 ? 0 : 2;
}
