import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import type { ChildInactivityDeployment } from '../config/childInactivityDeployment';
import { createChildInactivitySqlStore } from './childInactivitySqlStore';
import { createInAppInactivityQualityResolver } from './childInactivityInAppTarget';
import { runChildWarningMaintenance } from './childWarningMaintenance';
import { createBrevoChildWarningNonresponse } from './childWarningNonresponse';
import { createDurableChildWarningStore } from './durableChildWarningStore';
import { resolveChildWarningContact } from './childWarningContact';
import { verifyChildWarningReadiness } from '../migrations/childWarningReadiness';
import { verifyChildActivityContinuityReadiness } from '../migrations/childActivityContinuityReadiness';
import type { ChildActivityContinuityConfig } from '../config/childActivityContinuity';
import type { createDurableChildActivity } from './durableChildActivity';
import type { AppendOnlyObjectTransport } from './childContinuityAppendOnly';
import { createChildWarningWebhookRouter } from '../routers/childWarningWebhookRouter';
import { createGcsRetentionJournal } from './gcsRetentionJournal';
import type { JournalHttpClient } from './gcsDeletionJournal';
import { createPinnedPrimaryHealth } from './retentionPrimaryHealth';
import { createRetentionKeepReconciler } from './retentionKeepReconciler';
import { createChildWarningParentService } from './childWarningParentService';
import { verifyBrevoWarningAccess } from '../experimental/brevoInactivityMail';

/** Compose real storage and primary verification before exposing either operation. */
export async function prepareChildInactivityDeployment(database: Pool, config: ChildInactivityDeployment,
    options: Readonly<{ client?: JournalHttpClient; activityConfig?: ChildActivityContinuityConfig;
        activity?: ReturnType<typeof createDurableChildActivity>; transport?: AppendOnlyObjectTransport }> = {}) {
    const { activityConfig, activity, transport } = options;
    if (!activityConfig || !activity || !transport || !config.brevoApiKey
        || activityConfig.database !== config.database || activityConfig.serverUuid !== config.serverUuid
        || [config.journalKey, config.targetKey, config.receiptKey].some(key => !Buffer.isBuffer(key) || key.length !== 32
            || timingSafeEqual(key, activityConfig.key))) {
        throw new Error('Inactivity requires independent activity continuity and the warning delivery configuration.');
    }
    await verifyChildActivityContinuityReadiness(database, activityConfig);
    await verifyChildWarningReadiness(database);
    let health: ReturnType<typeof createPinnedPrimaryHealth>;
    const journal = createGcsRetentionJournal({ bucket: config.bucket, expectedBucket: config.bucket, key: config.journalKey, client: options.client,
        async verifyActivityContinuity(intent, connection) {
            if (!connection) return false;
            await activity.verifyActivity(connection, intent.childId);
            return health(connection, intent.parentId, intent.childId);
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
    const warnings = createDurableChildWarningStore(database, { database: config.database, serverUuid: config.serverUuid,
        bucket: activityConfig.bucket, key: config.targetKey, transport, verifyActivity: activity.verifyActivity,
        resolveContext: resolveChildWarningContact });
    const workflow = createBrevoChildWarningNonresponse(warnings, config.brevoApiKey);
    const keepStore = createChildInactivitySqlStore(database, createInAppInactivityQualityResolver(config.targetKey, async (connection, parentId, childId) => {
        await activity.verifyActivity(connection, childId);
        return health(connection, parentId, childId);
    }));
    const webhookToken = createHmac('sha256', config.receiptKey).update('brevo-warning-webhook-v1').digest('base64url');
    return Object.freeze({
        service: createChildWarningParentService(database, warnings),
        receiveBrevo: createChildWarningWebhookRouter(database, workflow, webhookToken),
        reconcileChildKeep: createRetentionKeepReconciler(keepStore, journal, config.receiptKey),
        async runMaintenance(): Promise<number> {
            await requireReadyPrimary();
            // Brevo expires even undated keys after 90 days unused. The scheduled
            // read also prevents destructive maintenance while provider access is unavailable.
            if (!await verifyBrevoWarningAccess(config.brevoApiKey!)) return 1;
            let cursor: string | null = null, held = 0;
            for (let page = 0; page < 100; page++) {
                const result = await runChildWarningMaintenance(database, warnings, workflow, journal, { afterChildId: cursor });
                held += result.held;
                if (result.nextAfterChildId === null) return held === 0 ? 0 : 1;
                cursor = result.nextAfterChildId;
            }
            return 1; // Bounded scan exhausted: report backlog, never claim completion.
        },
    });
}
