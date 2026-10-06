import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import { decideRegistration, type RegistrationPolicy } from '../config/registrationPolicy';
import { assertAccountId } from './deletionJournal';

const TIMEOUT_MS = 10_000;
/** Bounded cleanup for maintenance; expiry rejects use independently of physical deletion. */
export async function cleanupRegistrationAuthorizations(database: Pick<Pool, 'query'>): Promise<{ deleted: number; backlog: boolean }> {
    let deleted = 0;
    for (let batch = 0; batch < 10; batch++) {
        const [result] = await database.query<ResultSetHeader>({
            sql: 'DELETE FROM registration_authorizations WHERE expires_at <= UTC_TIMESTAMP(6) LIMIT 100', timeout: TIMEOUT_MS,
        });
        if (!Number.isInteger(result.affectedRows) || result.affectedRows < 0 || result.affectedRows > 100) throw new RegistrationRequiredError();
        deleted += result.affectedRows;
        if (result.affectedRows < 100) return { deleted, backlog: false };
    }
    const [rows] = await database.query<RowDataPacket[]>({
        sql: 'SELECT binding_hash FROM registration_authorizations WHERE expires_at <= UTC_TIMESTAMP(6) LIMIT 1', timeout: TIMEOUT_MS,
    });
    return { deleted, backlog: rows.length !== 0 };
}
export class RegistrationRequiredError extends Error {
    constructor() { super('A current registration authorization is required.'); }
}

function anonymousBinding(context: ProviderAuthContext | null): Buffer {
    if (!context || context.account !== null || context.session !== null
        || !Buffer.isBuffer(context.bindingHash) || context.bindingHash.length !== 32
        || context.bindingExpiresAt === null || context.bindingExpiresAt <= Date.now()) {
        throw new RegistrationRequiredError();
    }
    return context.bindingHash;
}

/** Shares one SQL authorization between password and provider account creation. */
export function createRegistrationAuthorization(database: Pick<Pool, 'query'>, policy?: RegistrationPolicy) {
    async function read(connection: Pick<PoolConnection, 'query'>, context: ProviderAuthContext | null, lock: boolean) {
        if (!policy) throw new RegistrationRequiredError();
        const binding = anonymousBinding(context);
        const [rows] = await connection.query<RowDataPacket[]>({
            sql: `SELECT country_code AS country, age_band AS ageBand FROM registration_authorizations
                WHERE binding_hash = ? AND policy_digest = ? AND consumed_at IS NULL
                    AND expires_at > UTC_TIMESTAMP(6) LIMIT 2${lock ? ' FOR UPDATE' : ''}`, timeout: TIMEOUT_MS,
        }, [binding, policy.digest]);
        if (!Array.isArray(rows) || rows.length !== 1) throw new RegistrationRequiredError();
        const decision = decideRegistration(policy, { country: rows[0].country, ageBand: rows[0].ageBand, policyVersion: policy.version });
        if (!decision.allowed) throw new RegistrationRequiredError();
        return { binding, decision };
    }
    return {
        policy,
        async cancel(context: ProviderAuthContext): Promise<void> {
            const binding = anonymousBinding(context);
            await database.query({ sql: 'DELETE FROM registration_authorizations WHERE binding_hash = ? AND consumed_at IS NULL', timeout: TIMEOUT_MS }, [binding]);
        },
        async begin(context: ProviderAuthContext | null, input: unknown) {
            const decision = decideRegistration(policy, input);
            if (!decision.allowed) return decision;
            const binding = anonymousBinding(context);
            // Opportunistic bounded removal; no account identifiers, email, exact DOB or provider tokens are stored here.
            await database.query({ sql: 'DELETE FROM registration_authorizations WHERE expires_at <= UTC_TIMESTAMP(6) LIMIT 100', timeout: TIMEOUT_MS });
            const [inserted] = await database.query<ResultSetHeader>({
                sql: `INSERT INTO registration_authorizations
                    (binding_hash, policy_digest, country_code, age_band, expires_at)
                    VALUES (?, ?, ?, ?, LEAST(?, UTC_TIMESTAMP(6) + INTERVAL 5 MINUTE))`, timeout: TIMEOUT_MS,
            // mysql2 serializes Date in the pool's local timezone. Bind an explicit UTC
            // DATETIME instead so local development cannot expire the grant hours early.
            }, [binding, policy!.digest, decision.country, decision.ageBand,
                new Date(context!.bindingExpiresAt!).toISOString().replace('T', ' ').replace('Z', '')]);
            if (inserted.affectedRows !== 1) throw new RegistrationRequiredError();
            return decision;
        },
        async assertAvailable(context: ProviderAuthContext | null): Promise<void> { await read(database, context, false); },
        /** Called inside the NEW account transaction; failures roll back user, identity, privacy and consumption together. */
        async consume(connection: PoolConnection, context: ProviderAuthContext | null, accountId: string): Promise<void> {
            assertAccountId(accountId);
            const { binding, decision } = await read(connection, context, true);
            const [profile] = await connection.query<ResultSetHeader>({
                sql: `INSERT INTO account_registration_profiles
                    (account_uuid, country_code, age_band, policy_version, score_visibility)
                    VALUES (?, ?, ?, ?, ?)`, timeout: TIMEOUT_MS,
            }, [accountId, decision.country, decision.ageBand, policy!.version, 'private']);
            if (profile.affectedRows !== 1) throw new RegistrationRequiredError();
            const [consumed] = await connection.query<ResultSetHeader>({
                sql: `UPDATE registration_authorizations SET consumed_at = UTC_TIMESTAMP(6)
                    WHERE binding_hash = ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(6)`, timeout: TIMEOUT_MS,
            }, [binding]);
            if (consumed.affectedRows !== 1) throw new RegistrationRequiredError();
        },
    };
}
export type RegistrationAuthorization = ReturnType<typeof createRegistrationAuthorization>;
