import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { verifyAccountIdentitySchema } from '../migrations/accountIdentitySchema';
import { verifyOptionalProviderIdentitySchema } from '../migrations/providerIdentitySchema';
import { verifyOptionalProviderAttemptSchema } from '../migrations/providerAttemptSchema';
import { verifyOptionalAccountSessionSchema } from '../migrations/accountSessionSchema';
import { verifyOptionalAppleTokenSchema } from '../migrations/appleTokenSchema';
import { verifySignedParentFormReadiness } from '../migrations/signedParentFormSchema';
import { verifyScoreParticipationReadiness } from '../migrations/scoreParticipationSchema';
import { verifyChildActivityContinuitySchema, verifyChildWarningHistorySchema } from '../migrations/childActivityContinuitySchema';
import { verifyRecoveryCheckpointSchema } from './recoveryCheckpointSchema';

/** Verify the reviewed account and child foreign-key chain before observation or retirement. */
export async function verifyRetirementSourceSchema(connection: Pick<PoolConnection, 'query'>): Promise<void> {
    const [flags] = await connection.query<RowDataPacket[]>({ sql: `SELECT @@SESSION.foreign_key_checks AS sessionChecks,
        @@GLOBAL.foreign_key_checks AS globalChecks`, timeout: 10_000 });
    if (!Array.isArray(flags) || flags.length !== 1 || ![1, '1'].includes(flags[0].sessionChecks)
        || ![1, '1'].includes(flags[0].globalChecks)) throw new Error('Foreign-key enforcement unavailable.');
    const timed: MigrationConnection = { query: (sql, values) => connection.query({ sql, timeout: 10_000 }, values) };
    await verifyAccountIdentitySchema(timed);
    await verifyOptionalProviderIdentitySchema(timed);
    await verifyOptionalProviderAttemptSchema(timed);
    await verifyOptionalAccountSessionSchema(timed);
    await verifyOptionalAppleTokenSchema(timed);
    await verifySignedParentFormReadiness(timed, true);
    await verifyScoreParticipationReadiness(timed);
    await verifyChildActivityContinuitySchema(timed);
    await verifyChildWarningHistorySchema(timed);
    for (const expected of [
        { table: 'parent_managed_child_activity', name: 'fk_child_activity_consent', refTable: 'parent_child_consents' },
        { table: 'parent_child_inactivity_warnings', name: 'fk_inactivity_warning_activity', refTable: 'parent_managed_child_activity' },
    ]) {
        const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT k.CONSTRAINT_NAME AS name,
            k.COLUMN_NAME AS col,k.REFERENCED_TABLE_NAME AS refTable,k.REFERENCED_COLUMN_NAME AS refCol,
            k.REFERENCED_TABLE_SCHEMA=DATABASE() AS sameSchema,r.DELETE_RULE AS deletion,r.UPDATE_RULE AS updateRule
            FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
            ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
            WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL`, timeout: 10_000 }, [expected.table]);
        if (!Array.isArray(rows) || rows.length !== 1 || rows[0].name !== expected.name
            || rows[0].col !== 'child_uuid' || rows[0].refTable !== expected.refTable || rows[0].refCol !== 'child_uuid'
            || ![1, '1'].includes(rows[0].sameSchema) || rows[0].deletion !== 'CASCADE' || rows[0].updateRule !== 'RESTRICT') {
            throw new Error('Child retention foreign key differs from the reviewed schema.');
        }
    }
}

export async function verifyRetirementSchemas(connection: Pick<PoolConnection, 'query'>): Promise<void> {
    await verifyRetirementSourceSchema(connection);
    await verifyRecoveryCheckpointSchema(connection);
}
