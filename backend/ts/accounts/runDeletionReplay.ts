import mysql from 'mysql2/promise';
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadDeletionReplayConfig } from '../config/deletionReplayConfig';
import { applyDeletionReplay, planDeletionReplay } from './deletionReplay';
import { createGcsRetentionJournal } from './gcsRetentionJournal';
import { parseRetentionKeyBundle } from './runRetentionReconciliation';
import { createGuardedDeletionReplayReader } from './guardedDeletionReplayReader';

export async function runDeletionReplay(args: readonly string[]): Promise<void> {
    const config = loadDeletionReplayConfig(args);
    const database = mysql.createPool({
        ...config.connection, connectTimeout: 10_000, connectionLimit: 2,
        waitForConnections: false, queueLimit: 1, multipleStatements: false,
        timezone: 'Z', dateStrings: true,
    });
    try {
        const { journalKey } = parseRetentionKeyBundle(process.env.CHILD_INACTIVITY_KEYS);
        const guard = createGcsRetentionJournal({ bucket: process.env.RETENTION_JOURNAL_BUCKET ?? '',
            expectedBucket: process.env.RETENTION_CONFIRM_BUCKET ?? '', key: journalKey,
            verifyActivityContinuity: async () => false });
        await guard.assertRestoreGuardHistory();
        const publicKeyPath = process.env.RETIREMENT_PUBLIC_KEY_FILE;
        const publicKey = publicKeyPath ? createPublicKey(readFileSync(publicKeyPath)) : undefined;
        const journal = await createGuardedDeletionReplayReader({ database, guard, publicKey,
            readTimeoutMs: config.settings.maxDurationMs, pins: { database: config.settings.database,
                currentUser: config.settings.expectedCurrentUser, targetServerUuid: config.settings.expectedServerUuid,
                originalServerUuid: config.settings.sourceServerUuid ?? config.settings.expectedServerUuid } });
        if (config.operation === 'plan') {
            const plan = await planDeletionReplay(database, journal, config.settings);
            console.log(JSON.stringify({
                operation: 'plan', mode: config.settings.mode, planSha256: plan.sha256,
                intentCount: plan.intentCount, accountCount: plan.accountCount,
                journalDigest: plan.journalDigest,
                note: 'Read-only plan. Traffic isolation is an operator attestation, not verified by this command.',
            }));
        } else {
            const result = await applyDeletionReplay(database, journal, config.settings, config.approvedPlanSha256!);
            console.log(JSON.stringify({
                operation: 'apply', ...result,
                note: 'Only account deletion reconciliation completed. This does not authorize traffic cutover or prove session invalidation.',
            }));
        }
    } finally { await database.end(); }
}

if (require.main === module) {
    runDeletionReplay(process.argv.slice(2)).catch(() => {
        // SQL/client errors may contain account details, local credentials, or journal identifiers.
        console.error('Deletion replay failed or is unconfirmed. Keep traffic stopped; review target, journal and plan before retrying. No cutover is authorized.');
        process.exitCode = 1;
    });
}
