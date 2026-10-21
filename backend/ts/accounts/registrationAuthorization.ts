import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { createHash } from 'node:crypto';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import { decideRegistration, type RegistrationPolicy } from '../config/registrationPolicy';
import { assertAccountId } from './deletionJournal';
import { createProviderAttempt } from '../auth/providerAttemptRepository';

const TIMEOUT_MS = 10_000;
const GENERAL_CLIENT = 'registration-general';
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

/** Eligibility may support existing provider login while all new-account consumption stays closed. */
export function createRegistrationAuthorization(database: Pick<Pool, 'query'> & Partial<Pick<Pool, 'getConnection'>>, policy?: RegistrationPolicy,
    audience: RegistrationPolicy['audience'] = policy?.audience, creationEnabled = true) {
    if (audience === 'children-included' && policy?.mode === 'general-audience') {
        throw new TypeError('Child registration requires staged eligibility.');
    }
    function generalGrant(context: ProviderAuthContext | null) {
        const original = anonymousBinding(context);
        if (policy?.mode !== 'general-audience') throw new RegistrationRequiredError();
        return {
            binding: createHash('sha256').update('ludolume:general-registration-binding:v1\0').update(original).digest(),
            state: createHash('sha256').update('ludolume:general-registration-state:v1\0').update(original).update(policy.digest).digest(),
            nonce: policy.digest.toString('base64url'),
        };
    }
    async function readGeneral(connection: Pick<PoolConnection, 'query'>, context: ProviderAuthContext | null, lock: boolean) {
        const grant = generalGrant(context);
        const [rows] = await connection.query<RowDataPacket[]>({
            sql: `SELECT nonce FROM provider_auth_attempts WHERE state_hash = ? AND binding_hash = ?
                AND BINARY client_key = ? AND BINARY action = 'signup' AND user_id IS NULL AND account_uuid IS NULL
                AND expires_at > UTC_TIMESTAMP(6) LIMIT 2${lock ? ' FOR UPDATE' : ''}`, timeout: TIMEOUT_MS,
        }, [grant.state, grant.binding, GENERAL_CLIENT]);
        if (!Array.isArray(rows) || rows.length !== 1 || rows[0].nonce !== grant.nonce) throw new RegistrationRequiredError();
        return grant;
    }
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
        audience,
        creationEnabled: !!policy && creationEnabled,
        async providerCollectionAllowed(accountId: string): Promise<boolean> {
            if (audience !== 'children-included') return true;
            assertAccountId(accountId);
            const [children] = await database.query<RowDataPacket[]>({
                sql: 'SELECT child_uuid FROM parent_child_consents WHERE child_uuid=? LIMIT 2', timeout: TIMEOUT_MS,
            }, [accountId]);
            if (!Array.isArray(children) || children.length > 1
                || children.some(child => child.child_uuid !== accountId)) throw new RegistrationRequiredError();
            return children.length === 0;
        },
        async cancel(context: ProviderAuthContext): Promise<void> {
            if (policy?.mode === 'general-audience') {
                const grant = generalGrant(context);
                await database.query({ sql: `DELETE FROM provider_auth_attempts WHERE binding_hash = ?
                    AND BINARY client_key = ? AND BINARY action = 'signup'`, timeout: TIMEOUT_MS }, [grant.binding, GENERAL_CLIENT]);
                return;
            }
            const binding = anonymousBinding(context);
            await database.query({ sql: 'DELETE FROM registration_authorizations WHERE binding_hash = ? AND consumed_at IS NULL', timeout: TIMEOUT_MS }, [binding]);
        },
        async begin(context: ProviderAuthContext | null, input: unknown) {
            const decision = decideRegistration(policy, input);
            if (!decision.allowed) return decision;
            if (policy?.mode === 'general-audience') {
                const grant = generalGrant(context);
                if (typeof database.getConnection !== 'function') throw new Error('Registration authorization is unavailable.');
                const created = await createProviderAttempt({ getConnection: database.getConnection.bind(database) }, {
                    stateHash: grant.state, bindingHash: grant.binding, nonce: grant.nonce,
                    clientKey: GENERAL_CLIENT, action: 'signup', accountId: null, userId: null,
                });
                if (created !== 'created') throw new Error('Registration authorization is unavailable.');
                return decision;
            }
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
        async assertAvailable(context: ProviderAuthContext | null): Promise<void> {
            if (!creationEnabled) throw new RegistrationRequiredError();
            if (policy?.mode === 'general-audience') await readGeneral(database, context, false);
            else await read(database, context, false);
        },
        async assertLoginAvailable(context: ProviderAuthContext | null): Promise<void> {
            if (audience !== 'children-included') throw new RegistrationRequiredError();
            await read(database, context, false);
        },
        /** Called inside the NEW account transaction; failures roll back user, identity, privacy and consumption together. */
        async consume(connection: PoolConnection, context: ProviderAuthContext | null, accountId: string): Promise<void> {
            if (!creationEnabled) throw new RegistrationRequiredError();
            assertAccountId(accountId);
            if (policy?.mode === 'general-audience') {
                const grant = await readGeneral(connection, context, true);
                const [permission] = await connection.query<ResultSetHeader>({
                    sql: `INSERT INTO account_score_permissions (account_uuid, visibility, confirmed_at)
                        VALUES (?, 'private', UTC_TIMESTAMP(6))`, timeout: TIMEOUT_MS,
                }, [accountId]);
                if (permission.affectedRows !== 1) throw new RegistrationRequiredError();
                const [consumed] = await connection.query<ResultSetHeader>({
                    sql: `DELETE FROM provider_auth_attempts WHERE state_hash = ? AND binding_hash = ?
                        AND BINARY client_key = ? AND BINARY action = 'signup' AND BINARY nonce = ?
                        AND user_id IS NULL AND account_uuid IS NULL AND expires_at > UTC_TIMESTAMP(6)`, timeout: TIMEOUT_MS,
                }, [grant.state, grant.binding, GENERAL_CLIENT, grant.nonce]);
                if (consumed.affectedRows !== 1) throw new RegistrationRequiredError();
                return;
            }
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
