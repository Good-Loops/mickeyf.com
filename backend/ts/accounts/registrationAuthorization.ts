import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import { decideRegistration, type RegistrationPolicy } from '../config/registrationPolicy';
import { assertAccountId } from './deletionJournal';
import { createProviderAttempt } from '../auth/providerAttemptRepository';
import { guardConnectionQueries } from '../db/queryTimeoutConnection';

const TIMEOUT_MS = 10_000;
// Reserve enough time for a normal native prompt and both transport calls;
// this is not a guarantee that an operating-system prompt will return.
const NATIVE_CHECK_MIN_REMAINING_MS = 5 * 60_000 + TIMEOUT_MS;
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
    if (!context || context.parentRequired || context.account !== null || context.session !== null
        || !Buffer.isBuffer(context.bindingHash) || context.bindingHash.length !== 32
        || context.bindingExpiresAt === null || context.bindingExpiresAt <= Date.now()) {
        throw new RegistrationRequiredError();
    }
    return context.bindingHash;
}

/** Screening records share the existing short-lived authorization store but have purpose-separated keys.
 * The mutex serializes younger observations with grant use and account/session commit. */
function screeningKey(context: ProviderAuthContext, purpose: 'mutex' | 'minor' | 'parent' | 'pending'): Buffer {
    return createHash('sha256').update(`ludolume:age-screen:${purpose}:v1\0`).update(context.bindingHash).digest();
}
function expiry(context: ProviderAuthContext): string {
    if (!context.screening || !context.bindingExpiresAt || context.bindingExpiresAt <= Date.now()) throw new RegistrationRequiredError();
    return new Date(context.bindingExpiresAt).toISOString().replace('T', ' ').replace('Z', '');
}
function requireNativeCheckLifetime(context: ProviderAuthContext): void {
    expiry(context);
    if (context.bindingExpiresAt! - Date.now() <= NATIVE_CHECK_MIN_REMAINING_MS) throw new RegistrationRequiredError();
}
async function screeningLock(connection: Pick<PoolConnection, 'query'>, context: ProviderAuthContext, policy: RegistrationPolicy) {
    const until = expiry(context);
    const key = screeningKey(context, 'mutex');
    await connection.query({ sql: `INSERT IGNORE INTO registration_authorizations
        (binding_hash, policy_digest, country_code, age_band, expires_at) VALUES (?, ?, 'ZZ', 'adult', ?)`, timeout: TIMEOUT_MS },
    [key, policy.digest, until]);
    const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT binding_hash FROM registration_authorizations
        WHERE binding_hash = ? AND policy_digest = ? AND country_code = 'ZZ' AND age_band = 'adult'
        AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(6) FOR UPDATE`, timeout: TIMEOUT_MS }, [key, policy.digest]);
    if (!Array.isArray(rows) || rows.length !== 1) throw new RegistrationRequiredError();
    expiry(context);
}
async function screeningMarkers(connection: Pick<PoolConnection, 'query'>, context: ProviderAuthContext, policy: RegistrationPolicy) {
    const minor = screeningKey(context, 'minor');
    const parent = screeningKey(context, 'parent');
    const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT binding_hash, policy_digest, country_code,
        age_band, consumed_at, expires_at > UTC_TIMESTAMP(6) AS valid_expiry FROM registration_authorizations
        WHERE binding_hash IN (?, ?)`, timeout: TIMEOUT_MS }, [minor, parent]);
    if (!Array.isArray(rows) || rows.length > 2 || rows.some(row => !Buffer.isBuffer(row.binding_hash)
        || !Buffer.isBuffer(row.policy_digest) || !row.policy_digest.equals(policy.digest) || row.country_code !== 'ZZ'
        || row.age_band !== 'minor' || row.consumed_at !== null || Number(row.valid_expiry) !== 1)) throw new RegistrationRequiredError();
    const has = (key: Buffer) => rows.some(row => row.binding_hash.equals(key));
    return { minor: has(minor), parent: has(parent) };
}
async function screeningPending(connection: Pick<PoolConnection, 'query'>, context: ProviderAuthContext): Promise<Buffer | null> {
    const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT policy_digest, country_code, age_band, consumed_at,
        expires_at > UTC_TIMESTAMP(6) AS valid_expiry FROM registration_authorizations WHERE binding_hash = ?`, timeout: TIMEOUT_MS },
    [screeningKey(context, 'pending')]);
    if (!Array.isArray(rows) || rows.length > 1) throw new RegistrationRequiredError();
    if (rows.length === 0) return null;
    const row = rows[0];
    if (!Buffer.isBuffer(row.policy_digest) || row.policy_digest.length !== 32 || row.country_code !== 'PN'
        || row.age_band !== 'adult' || row.consumed_at !== null || Number(row.valid_expiry) !== 1) throw new RegistrationRequiredError();
    return row.policy_digest;
}
function attemptDigest(policy: RegistrationPolicy, attempt: string): Buffer {
    return createHash('sha256').update('ludolume:native-age-attempt:v1\0').update(policy.digest).update(attempt).digest();
}
async function screeningObserve(connection: Pick<PoolConnection, 'query'>, context: ProviderAuthContext, policy: RegistrationPolicy,
    purpose: 'minor' | 'parent') {
    await connection.query({ sql: `INSERT IGNORE INTO registration_authorizations
        (binding_hash, policy_digest, country_code, age_band, expires_at) VALUES (?, ?, 'ZZ', 'minor', ?)`, timeout: TIMEOUT_MS },
    [screeningKey(context, purpose), policy.digest, expiry(context)]);
}

/** Eligibility may support existing provider login while all new-account consumption stays closed. */
export function createRegistrationAuthorization(database: Pick<Pool, 'query'> & Partial<Pick<Pool, 'getConnection'>>, policy?: RegistrationPolicy,
    audience: RegistrationPolicy['audience'] = policy?.audience, creationEnabled = true, adultOnly = false) {
    if (audience === 'children-included' && policy?.mode === 'general-audience') {
        throw new TypeError('Child registration requires staged eligibility.');
    }
    if (adultOnly && (audience !== 'children-included' || !policy || policy.mode === 'general-audience')) {
        throw new TypeError('Adult-only registration requires child-audience age screening.');
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
        if (audience === 'children-included') {
            if (!context?.screening) throw new RegistrationRequiredError();
            if (lock) await screeningLock(connection, context, policy);
            const markers = await screeningMarkers(connection, context, policy);
            if (await screeningPending(connection, context)) throw new RegistrationRequiredError();
            if (markers.parent) throw new RegistrationRequiredError();
        }
        const [rows] = await connection.query<RowDataPacket[]>({
            sql: `SELECT country_code AS country, age_band AS ageBand FROM registration_authorizations
                WHERE binding_hash = ? AND policy_digest = ? AND consumed_at IS NULL
                    AND expires_at > UTC_TIMESTAMP(6) LIMIT 2${lock ? ' FOR UPDATE' : ''}`, timeout: TIMEOUT_MS,
        }, [binding, policy.digest]);
        if (!Array.isArray(rows) || rows.length !== 1) throw new RegistrationRequiredError();
        const decision = decideRegistration(policy, { country: rows[0].country, ageBand: rows[0].ageBand, policyVersion: policy.version });
        if (!decision.allowed) throw new RegistrationRequiredError();
        if (audience === 'children-included' && decision.ageBand === 'adult'
            && (await screeningMarkers(connection, context!, policy)).minor) throw new RegistrationRequiredError();
        return { binding, decision };
    }
    async function assertAdultLogin(connection: Pick<PoolConnection, 'query'>, context: ProviderAuthContext | null, lock: boolean) {
        if (audience !== 'children-included') throw new RegistrationRequiredError();
        const { decision } = await read(connection, context, lock);
        // Login does not yet bind a minor's privacy decision to an existing account.
        // Refuse this path until public-score privacy can be enforced durably.
        if (decision.ageBand !== 'adult') throw new RegistrationRequiredError();
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
            if (context.parentRequired) return;
            if (policy?.mode === 'general-audience') {
                const grant = generalGrant(context);
                await database.query({ sql: `DELETE FROM provider_auth_attempts WHERE binding_hash = ?
                    AND BINARY client_key = ? AND BINARY action = 'signup'`, timeout: TIMEOUT_MS }, [grant.binding, GENERAL_CLIENT]);
                return;
            }
            const binding = anonymousBinding(context);
            await database.query({ sql: 'DELETE FROM registration_authorizations WHERE binding_hash = ? AND consumed_at IS NULL', timeout: TIMEOUT_MS }, [binding]);
        },
        async begin(context: ProviderAuthContext | null, input: unknown, observeOnly = false) {
            const decision = decideRegistration(policy, input);
            if (observeOnly && (audience !== 'children-included' || !policy
                || decision.allowed && decision.ageBand !== 'minor'
                || !decision.allowed && decision.reason !== 'PARENT_REQUIRED')) {
                return { allowed: false as const, reason: 'INVALID_REGISTRATION' as const };
            }
            if (audience === 'children-included' && policy && (decision.allowed || decision.reason === 'PARENT_REQUIRED')) {
                if (!context?.screening || context.parentRequired || !database.getConnection) throw new RegistrationRequiredError();
                const binding = anonymousBinding(context);
                // Bounded opportunistic cleanup supplements the scheduled expiry job.
                await database.query({ sql: 'DELETE FROM registration_authorizations WHERE expires_at <= UTC_TIMESTAMP(6) LIMIT 100', timeout: TIMEOUT_MS });
                const connection = guardConnectionQueries(await database.getConnection());
                let phase: 'begin' | 'active' | 'commit' = 'begin';
                let reusable = true;
                try {
                    await connection.query({ sql: 'START TRANSACTION', timeout: TIMEOUT_MS }); phase = 'active';
                    await screeningLock(connection, context, policy);
                    const markers = await screeningMarkers(connection, context, policy);
                    const pending = await screeningPending(connection, context);
                    if (pending && !observeOnly) throw new RegistrationRequiredError();
                    if (!decision.allowed || decision.ageBand === 'minor') {
                        await screeningObserve(connection, context, policy, decision.allowed ? 'minor' : 'parent');
                    }
                    await connection.query({ sql: 'DELETE FROM registration_authorizations WHERE binding_hash = ? AND consumed_at IS NULL', timeout: TIMEOUT_MS }, [binding]);
                    if (observeOnly) { phase = 'commit'; await connection.query({ sql: 'COMMIT', timeout: TIMEOUT_MS }); return decision; }
                    if (!decision.allowed || (adultOnly && decision.ageBand !== 'adult')
                        || markers.parent || (decision.ageBand === 'adult' && markers.minor)) {
                        phase = 'commit'; await connection.query({ sql: 'COMMIT', timeout: TIMEOUT_MS });
                        return { allowed: false as const, reason: 'PARENT_REQUIRED' as const };
                    }
                    const [inserted] = await connection.query<ResultSetHeader>({ sql: `INSERT INTO registration_authorizations
                        (binding_hash, policy_digest, country_code, age_band, expires_at)
                        VALUES (?, ?, ?, ?, LEAST(?, UTC_TIMESTAMP(6) + INTERVAL 5 MINUTE))`, timeout: TIMEOUT_MS },
                    [binding, policy.digest, decision.country, decision.ageBand, expiry(context)]);
                    if (inserted.affectedRows !== 1) throw new RegistrationRequiredError();
                    phase = 'commit'; await connection.query({ sql: 'COMMIT', timeout: TIMEOUT_MS });
                    return decision;
                } catch (error) {
                    if (phase !== 'active') reusable = false;
                    else { try { await connection.query({ sql: 'ROLLBACK', timeout: TIMEOUT_MS }); } catch { reusable = false; } }
                    throw error;
                } finally { if (reusable) connection.release(); else connection.destroy(); }
            }
            if (!decision.allowed) return decision;
            if (context?.parentRequired) return { allowed: false as const, reason: 'PARENT_REQUIRED' as const };
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
        /** A single unresolved native check blocks grants until its matching completion or expiry. */
        async beginNativeAgeCheck(context: ProviderAuthContext | null): Promise<string> {
            if (audience !== 'children-included' || !policy || !context?.screening || context.parentRequired || !database.getConnection)
                throw new RegistrationRequiredError();
            const binding = anonymousBinding(context);
            requireNativeCheckLifetime(context);
            await database.query({ sql: 'DELETE FROM registration_authorizations WHERE expires_at <= UTC_TIMESTAMP(6) LIMIT 100', timeout: TIMEOUT_MS });
            const connection = guardConnectionQueries(await database.getConnection());
            let phase: 'begin' | 'active' | 'commit' = 'begin'; let reusable = true;
            try {
                await connection.query({ sql: 'START TRANSACTION', timeout: TIMEOUT_MS }); phase = 'active';
                await screeningLock(connection, context, policy);
                requireNativeCheckLifetime(context);
                await screeningMarkers(connection, context, policy);
                if (await screeningPending(connection, context)) throw new RegistrationRequiredError();
                const attempt = randomBytes(32).toString('base64url');
                const [inserted] = await connection.query<ResultSetHeader>({ sql: `INSERT INTO registration_authorizations
                    (binding_hash, policy_digest, country_code, age_band, expires_at) VALUES (?, ?, 'PN', 'adult', ?)`, timeout: TIMEOUT_MS },
                [screeningKey(context, 'pending'), attemptDigest(policy, attempt), expiry(context)]);
                if (inserted.affectedRows !== 1) throw new RegistrationRequiredError();
                await connection.query({ sql: 'DELETE FROM registration_authorizations WHERE binding_hash = ? AND consumed_at IS NULL', timeout: TIMEOUT_MS }, [binding]);
                requireNativeCheckLifetime(context);
                phase = 'commit'; await connection.query({ sql: 'COMMIT', timeout: TIMEOUT_MS }); return attempt;
            } catch (error) {
                if (phase !== 'active') reusable = false;
                else { try { await connection.query({ sql: 'ROLLBACK', timeout: TIMEOUT_MS }); } catch { reusable = false; } }
                throw error;
            } finally { if (reusable) connection.release(); else connection.destroy(); }
        },
        async finishNativeAgeCheck(context: ProviderAuthContext | null, attempt: unknown, input: unknown): Promise<void> {
            if (audience !== 'children-included' || !policy || !context?.screening || context.parentRequired || !database.getConnection
                || typeof attempt !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(attempt)) throw new RegistrationRequiredError();
            const decision = decideRegistration(policy, input);
            if (!decision.allowed && decision.reason !== 'PARENT_REQUIRED') throw new RegistrationRequiredError();
            const binding = anonymousBinding(context);
            const connection = guardConnectionQueries(await database.getConnection());
            let phase: 'begin' | 'active' | 'commit' = 'begin'; let reusable = true;
            try {
                await connection.query({ sql: 'START TRANSACTION', timeout: TIMEOUT_MS }); phase = 'active';
                await screeningLock(connection, context, policy);
                await screeningMarkers(connection, context, policy);
                const pending = await screeningPending(connection, context);
                const expected = attemptDigest(policy, attempt);
                if (!pending || !timingSafeEqual(pending, expected)) throw new RegistrationRequiredError();
                if (!decision.allowed || decision.ageBand === 'minor')
                    await screeningObserve(connection, context, policy, decision.allowed ? 'minor' : 'parent');
                await connection.query({ sql: 'DELETE FROM registration_authorizations WHERE binding_hash = ? AND consumed_at IS NULL', timeout: TIMEOUT_MS }, [binding]);
                const [removed] = await connection.query<ResultSetHeader>({ sql: 'DELETE FROM registration_authorizations WHERE binding_hash = ? AND policy_digest = ? AND consumed_at IS NULL', timeout: TIMEOUT_MS },
                    [screeningKey(context, 'pending'), expected]);
                if (removed.affectedRows !== 1) throw new RegistrationRequiredError();
                expiry(context);
                phase = 'commit'; await connection.query({ sql: 'COMMIT', timeout: TIMEOUT_MS });
            } catch (error) {
                if (phase !== 'active') reusable = false;
                else { try { await connection.query({ sql: 'ROLLBACK', timeout: TIMEOUT_MS }); } catch { reusable = false; } }
                throw error;
            } finally { if (reusable) connection.release(); else connection.destroy(); }
        },
        async assertAvailable(context: ProviderAuthContext | null): Promise<void> {
            if (!creationEnabled) throw new RegistrationRequiredError();
            if (policy?.mode === 'general-audience') await readGeneral(database, context, false);
            else {
                const { decision } = await read(database, context, false);
                if (adultOnly && decision.ageBand !== 'adult') throw new RegistrationRequiredError();
            }
        },
        async assertLoginAvailable(context: ProviderAuthContext | null): Promise<void> {
            await assertAdultLogin(database, context, false);
        },
        async assertLoginAvailableOnConnection(connection: Pick<PoolConnection, 'query'>,
            context: ProviderAuthContext | null): Promise<void> {
            // The session transaction holds this row lock until commit, so a
            // concurrent cancellation cannot invalidate the grant before issuance.
            await assertAdultLogin(connection, context, true);
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
            if (adultOnly && decision.ageBand !== 'adult') throw new RegistrationRequiredError();
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
