import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { CHILD_RETENTION_BUCKET } from '../config/childInactivityDeployment';
import { PRODUCTION_CLOUD_SQL_TARGET } from '../security/cloudSqlRuntimeRoleRemover';
import { createGcsRetentionJournal } from './gcsRetentionJournal';
import { collectCloudSqlRecoveryInventory, createCloudSqlMetadataClient } from './cloudSqlRecoveryInventory';
import { assertNoRetentionRuntimeWriters } from './retentionReconciliation';
import { verifyRetirementSourceSchema } from './retirementSourceSchema';

/** Construct only the real provider, guard and reviewed-schema dependencies. */
export function createProductionRecoveryCheckpointSetup(options: Readonly<{
    connection: Pick<PoolConnection, 'query' | 'destroy'>; pins: Readonly<{ database: string; currentUser: string; serverUuid: string }>;
    sourceCommit: string; guardKey: Buffer; verifySource(): void;
}>) {
    if (options.pins.database !== 'cms' || options.pins.currentUser !== 'ludolume_release_ops@cloudsqlproxy~%'
        || options.pins.serverUuid !== PRODUCTION_CLOUD_SQL_TARGET.serverUuid) throw new Error('Unapproved checkpoint target.');
    const guard = createGcsRetentionJournal({ bucket: CHILD_RETENTION_BUCKET, expectedBucket: CHILD_RETENTION_BUCKET,
        key: options.guardKey, verifyActivityContinuity: async () => false });
    const cloud = createCloudSqlMetadataClient();
    return { connection: options.connection, pins: options.pins, sourceCommit: options.sourceCommit,
        guard, verifySource: options.verifySource, verifyAccountSchema: verifyRetirementSourceSchema,
        verifyWritersFenced: assertNoRetentionRuntimeWriters, async verifyRecoveryAvailable() {
            const [rows] = await options.connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS db,CURRENT_USER() AS user,
                @@GLOBAL.server_uuid AS uuid,DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`, timeout: 10_000 });
            if (!Array.isArray(rows) || rows.length !== 1 || rows[0].db !== options.pins.database
                || rows[0].user !== options.pins.currentUser || rows[0].uuid !== options.pins.serverUuid) throw new Error();
            await collectCloudSqlRecoveryInventory({ project: PRODUCTION_CLOUD_SQL_TARGET.project,
                instance: PRODUCTION_CLOUD_SQL_TARGET.instance, observedAt: rows[0].nowUtc, client: cloud });
        } };
}
