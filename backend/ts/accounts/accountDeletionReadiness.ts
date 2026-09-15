import type { Pool, PoolConnection } from 'mysql2/promise';
import { assertAccountIdentityEpoch, verifyAccountIdentitySchema } from '../migrations/accountIdentitySchema';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { PROVIDER_IDENTITY_MIGRATION_VERSION, verifyOptionalProviderIdentitySchema,
    verifyProviderIdentitySchema } from '../migrations/providerIdentitySchema';
import { PROVIDER_ATTEMPT_MIGRATION_VERSION, PROVIDER_ATTEMPT_ACTIONS_MIGRATION_VERSION,
    inspectProviderAttemptStage, verifyOptionalProviderAttemptSchema,
    verifyProviderAttemptSchema } from '../migrations/providerAttemptSchema';
import { ACCOUNT_SESSION_MIGRATION_VERSION, ACCOUNT_SESSION_RENEWAL_MIGRATION_VERSION,
    verifyRenewableAccountSessionSchema, verifyOptionalAccountSessionSchema } from '../migrations/accountSessionSchema';

const READINESS_TIMEOUT_MS = 10_000;

export class AccountDeletionReadinessError extends Error {
    constructor() {
        super('Account deletion recovery readiness could not be verified');
        this.name = 'AccountDeletionReadinessError';
    }
}

export class AccountSessionReadinessError extends Error {
    constructor() {
        super('Account session storage readiness could not be verified');
        this.name = 'AccountSessionReadinessError';
    }
}

export class ProviderAuthReadinessError extends Error {
    constructor() {
        super('Provider authentication storage readiness could not be verified');
        this.name = 'ProviderAuthReadinessError';
    }
}

/** Called only when deletion is enabled; failure must prevent serving the enabled endpoint. */
export async function verifyAccountDeletionReadiness(
    database: Pick<Pool, 'getConnection'>,
    expectedEpoch: string,
): Promise<void> {
    await verifyAccountStorageReadiness(database, AccountDeletionReadinessError, async metadata => {
        await assertAccountIdentityEpoch(metadata, expectedEpoch);
        await verifyAccountIdentitySchema(metadata);
        await verifyOptionalProviderIdentitySchema(metadata);
        await verifyOptionalProviderAttemptSchema(metadata);
        await verifyOptionalAccountSessionSchema(metadata);
    });
}

/** Session-enabled application startup requires a recorded migration, not an unrecorded lookalike table. */
export async function verifyAccountSessionReadiness(database: Pick<Pool, 'getConnection'>): Promise<void> {
    await verifyAccountStorageReadiness(database, AccountSessionReadinessError, async metadata => {
        for (const version of [ACCOUNT_SESSION_MIGRATION_VERSION, ACCOUNT_SESSION_RENEWAL_MIGRATION_VERSION]) {
            const [recorded] = await metadata.query('SELECT version FROM schema_migrations WHERE version = ?', [version]);
            if (!Array.isArray(recorded) || recorded.length !== 1
                || (recorded[0] as { version?: unknown }).version !== version) {
                throw new AccountSessionReadinessError();
            }
        }
        await verifyAccountIdentitySchema(metadata);
        await verifyRenewableAccountSessionSchema(metadata);
    });
}

/** Enabled authentication cannot use the optional-table rules reserved for old-backup recovery. */
export async function verifyProviderAuthReadiness(
    database: Pick<Pool, 'getConnection'>, requiresExtendedAttempts = false,
): Promise<void> {
    await verifyAccountStorageReadiness(database, ProviderAuthReadinessError, async metadata => {
        for (const version of [PROVIDER_IDENTITY_MIGRATION_VERSION, PROVIDER_ATTEMPT_MIGRATION_VERSION]) {
            const [recorded] = await metadata.query('SELECT version FROM schema_migrations WHERE version = ?', [version]);
            if (!Array.isArray(recorded) || recorded.length !== 1
                || (recorded[0] as { version?: unknown }).version !== version) {
                throw new ProviderAuthReadinessError();
            }
        }
        await verifyProviderIdentitySchema(metadata);
        const stage = await inspectProviderAttemptStage(metadata);
        if (requiresExtendedAttempts && stage !== 'extended') throw new ProviderAuthReadinessError();
        const [extended] = await metadata.query('SELECT version FROM schema_migrations WHERE version = ?',
            [PROVIDER_ATTEMPT_ACTIONS_MIGRATION_VERSION]);
        const expectedRecords = stage === 'extended' ? 1 : 0;
        if (!Array.isArray(extended) || extended.length !== expectedRecords
            || extended.some(record => record?.version !== PROVIDER_ATTEMPT_ACTIONS_MIGRATION_VERSION)) {
            throw new ProviderAuthReadinessError();
        }
        await verifyProviderAttemptSchema(metadata, stage);
    });
}

async function verifyAccountStorageReadiness(
    database: Pick<Pool, 'getConnection'>,
    ReadinessError: new () => Error,
    verifyMetadata: (metadata: MigrationConnection) => Promise<void>,
): Promise<void> {
    let connection: PoolConnection | undefined;
    let expired = false;
    let queryFailed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const verify = async () => {
        const acquired = await database.getConnection();
        // A queued pool acquisition can finish after startup has already failed.
        if (expired) {
            acquired.release();
            throw new ReadinessError();
        }
        connection = acquired;
        const metadata: MigrationConnection = {
            async query(sql, values) {
                if (expired) throw new ReadinessError();
                try {
                    const result = await acquired.query({ sql, timeout: READINESS_TIMEOUT_MS }, values);
                    if (expired) throw new ReadinessError();
                    return result;
                } catch (error) {
                    queryFailed = true;
                    throw error;
                }
            },
        };
        await verifyMetadata(metadata);
    };

    try {
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                expired = true;
                reject(new ReadinessError());
            }, READINESS_TIMEOUT_MS);
        });
        await Promise.race([verify(), deadline]);
    } catch {
        // Driver failures can contain database configuration; keep them out of startup logs.
        throw new ReadinessError();
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (connection !== undefined) {
            if (expired || queryFailed) connection.destroy();
            else connection.release();
        }
    }
}
