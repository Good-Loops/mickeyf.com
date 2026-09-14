import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from '../accounts/deletionJournal';

export type ProviderAttemptAction = 'login' | 'link' | 'signup' | 'delete';
export type ProviderAttempt = Readonly<{
    stateHash: Buffer;
    bindingHash: Buffer;
    nonce: string;
    clientKey: string;
    action: ProviderAttemptAction;
    accountId: string | null;
    userId: number | null;
}>;
export type ConsumedProviderAttempt = Readonly<Pick<ProviderAttempt, 'nonce' | 'accountId' | 'userId'>>;
export type ProviderAttemptCreateResult = 'created' | 'busy';

type AttemptDatabase = Pick<Pool, 'getConnection'>;
type ConnectionContext = {
    connection: PoolConnection;
    reusable: boolean;
};

const QUERY_TIMEOUT_MS = 10_000;
const MAX_PENDING_ATTEMPTS = 10_000;
const EXPIRED_CLEANUP_BATCH = 100;
const CREATION_LOCK = "CONCAT('mickeyf:provider-attempts:', LEFT(SHA2(DATABASE(), 256), 16))";

export class ProviderAttemptUnavailableError extends Error {
    constructor() {
        super('The provider attempt operation could not be confirmed.');
        this.name = 'ProviderAttemptUnavailableError';
    }
}

function validNonce(nonce: unknown): nonce is string {
    return typeof nonce === 'string' && /^[A-Za-z0-9_-]{43}$/.test(nonce)
        && Buffer.from(nonce, 'base64url').toString('base64url') === nonce;
}

function validTarget(action: ProviderAttemptAction, target: { userId: unknown; accountId: unknown }): boolean {
    return action === 'login' || action === 'signup' ? target.userId === null && target.accountId === null
        : Number.isSafeInteger(target.userId) && Number(target.userId) > 0
            && Number(target.userId) <= 2_147_483_647 && isAccountId(target.accountId);
}

function assertBinding(stateHash: Buffer, bindingHash: Buffer, clientKey: string, action: ProviderAttemptAction): void {
    if (!Buffer.isBuffer(stateHash) || stateHash.length !== 32
        || !Buffer.isBuffer(bindingHash) || bindingHash.length !== 32
        || typeof clientKey !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(clientKey)
        || !['login', 'link', 'signup', 'delete'].includes(action)) {
        throw new TypeError('A valid provider attempt binding is required.');
    }
}

async function withConnection<T>(database: AttemptDatabase, operation: (context: ConnectionContext) => Promise<T>): Promise<T> {
    try {
        const context: ConnectionContext = { connection: await database.getConnection(), reusable: true };
        try { return await operation(context); }
        finally {
            if (context.reusable) context.connection.release();
            else context.connection.destroy();
        }
    } catch {
        // Driver errors can contain parameters and connection details; never preserve their cause.
        throw new ProviderAttemptUnavailableError();
    }
}

async function inTransaction<T>(context: ConnectionContext, operation: () => Promise<T>): Promise<T> {
    const { connection } = context;
    let phase: 'begin' | 'active' | 'commit' = 'begin';
    try {
        await connection.query({ sql: 'START TRANSACTION', timeout: QUERY_TIMEOUT_MS });
        phase = 'active';
        const result = await operation();
        phase = 'commit';
        await connection.query({ sql: 'COMMIT', timeout: QUERY_TIMEOUT_MS });
        return result;
    } catch (error) {
        if (phase !== 'active') context.reusable = false;
        else {
            try { await connection.query({ sql: 'ROLLBACK', timeout: QUERY_TIMEOUT_MS }); }
            catch { context.reusable = false; }
        }
        throw error;
    }
}

async function withCreationLock(
    context: ConnectionContext, operation: () => Promise<ProviderAttemptCreateResult>,
): Promise<ProviderAttemptCreateResult> {
    let acquired: unknown;
    try {
        const [rows] = await context.connection.query<RowDataPacket[]>({
            sql: `SELECT GET_LOCK(${CREATION_LOCK}, 5) AS acquired`, timeout: QUERY_TIMEOUT_MS,
        });
        acquired = rows[0]?.acquired;
    } catch (error) {
        context.reusable = false;
        throw error;
    }
    if (acquired === 0) return 'busy';
    if (acquired !== 1) {
        context.reusable = false;
        throw new ProviderAttemptUnavailableError();
    }
    try { return await operation(); }
    finally {
        if (context.reusable) {
            try {
                const [rows] = await context.connection.query<RowDataPacket[]>({
                    sql: `SELECT RELEASE_LOCK(${CREATION_LOCK}) AS released`, timeout: QUERY_TIMEOUT_MS,
                });
                if (rows[0]?.released !== 1) throw new ProviderAttemptUnavailableError();
            } catch (error) {
                context.reusable = false;
                throw error;
            }
        }
    }
}

/** One pending attempt per browser binding; bounded storage and cleanup need no background worker. */
export async function createProviderAttempt(database: AttemptDatabase, attempt: ProviderAttempt): Promise<ProviderAttemptCreateResult> {
    if (!attempt) throw new TypeError('A valid provider attempt is required.');
    assertBinding(attempt.stateHash, attempt.bindingHash, attempt.clientKey, attempt.action);
    if (!validNonce(attempt.nonce) || !validTarget(attempt.action, attempt)) {
        throw new TypeError('A valid provider attempt is required.');
    }
    const stored = { ...attempt, stateHash: Buffer.from(attempt.stateHash), bindingHash: Buffer.from(attempt.bindingHash) };
    return withConnection(database, context => withCreationLock(context, () => inTransaction(context, async () => {
        const { connection } = context;
        await connection.query({
            sql: `DELETE FROM provider_auth_attempts WHERE expires_at <= UTC_TIMESTAMP(6)
                ORDER BY expires_at LIMIT ${EXPIRED_CLEANUP_BATCH}`, timeout: QUERY_TIMEOUT_MS,
        });
        await connection.query({
            sql: 'DELETE FROM provider_auth_attempts WHERE binding_hash = ?', timeout: QUERY_TIMEOUT_MS,
        }, [stored.bindingHash]);
        // All creators share this database-scoped lock. Concurrent consumers only reduce the count.
        const [rows] = await connection.query<RowDataPacket[]>({
            sql: `SELECT COUNT(*) AS pendingCount FROM (
                SELECT state_hash FROM provider_auth_attempts LIMIT ${MAX_PENDING_ATTEMPTS}
            ) AS bounded_attempts`, timeout: QUERY_TIMEOUT_MS,
        });
        const count = rows[0]?.pendingCount;
        if (!Number.isSafeInteger(count) || count < 0 || count > MAX_PENDING_ATTEMPTS) {
            throw new ProviderAttemptUnavailableError();
        }
        if (count === MAX_PENDING_ATTEMPTS) return 'busy';
        const [inserted] = await connection.query<ResultSetHeader>({
            sql: `INSERT INTO provider_auth_attempts
                (state_hash, binding_hash, nonce, client_key, action, user_id, account_uuid, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6) + INTERVAL 5 MINUTE)`, timeout: QUERY_TIMEOUT_MS,
        }, [stored.stateHash, stored.bindingHash, stored.nonce, stored.clientKey, stored.action, stored.userId, stored.accountId]);
        if (inserted.affectedRows !== 1) throw new ProviderAttemptUnavailableError();
        return 'created';
    })));
}

/** Only a matching consumer may remove the row, and the removal commits before returning its nonce. */
export async function consumeProviderAttempt(
    database: AttemptDatabase, stateHash: Buffer, bindingHash: Buffer, clientKey: string, action: ProviderAttemptAction,
): Promise<ConsumedProviderAttempt | null> {
    assertBinding(stateHash, bindingHash, clientKey, action);
    const state = Buffer.from(stateHash);
    const binding = Buffer.from(bindingHash);
    return withConnection(database, context => inTransaction(context, async () => {
        const { connection } = context;
        const [rows] = await connection.query<(RowDataPacket & ConsumedProviderAttempt)[]>({
            sql: `SELECT nonce, user_id AS userId, account_uuid AS accountId FROM provider_auth_attempts
                WHERE state_hash = ? AND binding_hash = ? AND BINARY client_key = BINARY ?
                AND BINARY action = BINARY ? LIMIT 1 FOR UPDATE`, timeout: QUERY_TIMEOUT_MS,
        }, [state, binding, clientKey, action]);
        if (!Array.isArray(rows) || rows.length > 1) throw new ProviderAttemptUnavailableError();
        const row = rows[0];
        if (!row) return null;
        if (!validNonce(row.nonce) || !validTarget(action, row)) throw new ProviderAttemptUnavailableError();
        // Evaluate expiration after obtaining the row lock, using the database clock for every instance.
        const [removed] = await connection.query<ResultSetHeader>({
            sql: 'DELETE FROM provider_auth_attempts WHERE state_hash = ? AND expires_at > UTC_TIMESTAMP(6)',
            timeout: QUERY_TIMEOUT_MS,
        }, [state]);
        if (removed.affectedRows === 1) {
            return Object.freeze({ nonce: row.nonce, userId: row.userId, accountId: row.accountId });
        }
        if (removed.affectedRows !== 0) throw new ProviderAttemptUnavailableError();
        const [expired] = await connection.query<ResultSetHeader>({
            sql: 'DELETE FROM provider_auth_attempts WHERE state_hash = ?', timeout: QUERY_TIMEOUT_MS,
        }, [state]);
        if (expired.affectedRows !== 1) throw new ProviderAttemptUnavailableError();
        return null;
    }));
}
