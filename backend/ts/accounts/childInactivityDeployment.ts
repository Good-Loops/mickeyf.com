import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import type { ChildInactivityDeployment } from '../config/childInactivityDeployment';
import { createChildInactivitySqlStore } from './childInactivitySqlStore';
import { createInAppInactivityQualityResolver } from './childInactivityInAppTarget';
import { runChildInactivityMaintenanceCycle } from './childInactivityMaintenance';
import { prepareChildInactivityRuntime } from './childInactivityRuntime';
import { createGcsRetentionJournal } from './gcsRetentionJournal';
import type { JournalHttpClient } from './gcsDeletionJournal';
import { createPinnedPrimaryHealth } from './retentionPrimaryHealth';
import { createRetentionKeepReconciler } from './retentionKeepReconciler';

/** Compose real storage and primary verification before exposing either operation. */
export async function prepareChildInactivityDeployment(database: Pool, config: ChildInactivityDeployment,
    options: Readonly<{ client?: JournalHttpClient }> = {}) {
    let health: ReturnType<typeof createPinnedPrimaryHealth>;
    const journal = createGcsRetentionJournal({ bucket: config.bucket, expectedBucket: config.bucket, key: config.journalKey, client: options.client,
        async verifyActivityContinuity(intent) {
            const connection = await database.getConnection();
            try { return await health(connection, intent.parentId, intent.childId); }
            finally { connection.release(); }
        } });
    health = createPinnedPrimaryHealth({ database: config.database, serverUuid: config.serverUuid, journal });
    async function requireReadyPrimary(): Promise<void> {
        const probe = await database.getConnection();
        try {
            // Random, unused identifiers check primary/guard readiness without inspecting a real account.
            if (!await health(probe, randomUUID(), randomUUID())) throw new Error('Inactivity primary or retention guard is unavailable.');
        } finally { probe.release(); }
    }
    await requireReadyPrimary();
    const service = await prepareChildInactivityRuntime(database, config.targetKey, config.receiptKey, health);
    const store = createChildInactivitySqlStore(database, createInAppInactivityQualityResolver(config.targetKey, health));
    return Object.freeze({ service, reconcileChildKeep: createRetentionKeepReconciler(store, journal, config.receiptKey),
        async runMaintenance(): Promise<number> {
            await requireReadyPrimary();
            const result = await runChildInactivityMaintenanceCycle(database, store, journal, { afterChildId: null });
            // Held candidates and an unfinished page need follow-up; do not report a clean run.
            return result.nextAfterChildId === null && result.held === 0 ? 0 : 1;
        },
    });
}
