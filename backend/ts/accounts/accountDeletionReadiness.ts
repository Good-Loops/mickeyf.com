import type { Pool, PoolConnection } from 'mysql2/promise';
import { assertAccountIdentityEpoch, verifyAccountIdentitySchema } from '../migrations/accountIdentitySchema';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { verifyOptionalProviderIdentitySchema } from '../migrations/providerIdentitySchema';

const READINESS_TIMEOUT_MS = 10_000;

export class AccountDeletionReadinessError extends Error {
    constructor() {
        super('Account deletion recovery readiness could not be verified');
        this.name = 'AccountDeletionReadinessError';
    }
}

/** Called only when deletion is enabled; failure must prevent serving the enabled endpoint. */
export async function verifyAccountDeletionReadiness(
    database: Pick<Pool, 'getConnection'>,
    expectedEpoch: string,
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
            throw new AccountDeletionReadinessError();
        }
        connection = acquired;
        const metadata: MigrationConnection = {
            async query(sql, values) {
                if (expired) throw new AccountDeletionReadinessError();
                try {
                    const result = await acquired.query({ sql, timeout: READINESS_TIMEOUT_MS }, values);
                    if (expired) throw new AccountDeletionReadinessError();
                    return result;
                } catch (error) {
                    queryFailed = true;
                    throw error;
                }
            },
        };
        await assertAccountIdentityEpoch(metadata, expectedEpoch);
        await verifyAccountIdentitySchema(metadata);
        await verifyOptionalProviderIdentitySchema(metadata);
    };

    try {
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                expired = true;
                reject(new AccountDeletionReadinessError());
            }, READINESS_TIMEOUT_MS);
        });
        await Promise.race([verify(), deadline]);
    } catch {
        // Driver failures can contain database configuration; keep them out of startup logs.
        throw new AccountDeletionReadinessError();
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (connection !== undefined) {
            if (expired || queryFailed) connection.destroy();
            else connection.release();
        }
    }
}
