import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { createHash, timingSafeEqual } from 'node:crypto';
import { guardConnectionQueries } from '../db/queryTimeoutConnection';
import { AppleAndroidHandoffError, copyAppleAndroidHandoffBinding, type AppleAndroidHandoffBinding,
    type AppleAndroidHandoffCredential, type createAppleAndroidHandoffCrypto } from './appleAndroidHandoffCrypto';

export const APPLE_ANDROID_HANDOFF_CAP = 1000;
const TIMEOUT = 10_000;
const LOCK = "CONCAT('mickeyf:apple-android:', LEFT(SHA2(DATABASE(), 256), 16))";
// Match createProviderAttempt's existing lock before touching multiple FK children.
const PARENT_CREATION_LOCK = "CONCAT('mickeyf:provider-attempts:', LEFT(SHA2(DATABASE(), 256), 16))";
type Database = Pick<Pool, 'getConnection'>;
type Cipher = ReturnType<typeof createAppleAndroidHandoffCrypto>;
const COLUMNS = `state_hash AS stateHash, binding_hash AS bindingHash, nonce, client_key AS clientKey,
    action, account_uuid AS accountId, user_id AS userId,
    TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', expires_at) DIV 1000 AS expiresAt`;
const MATCH = `state_hash = ? AND binding_hash = ? AND BINARY nonce = BINARY ? AND BINARY client_key = BINARY ?
    AND BINARY action = BINARY ? AND account_uuid <=> ? AND user_id <=> ? AND expires_at = CAST(? AS DATETIME(6))`;
function utc(milliseconds: number) { return new Date(milliseconds).toISOString().replace('T', ' ').slice(0, -1); }
function values(value: AppleAndroidHandoffBinding) {
    return [value.stateHash, value.bindingHash, value.nonce, value.clientKey, value.action,
        value.accountId, value.userId, utc(value.expiresAt)];
}
function rowBinding(row: RowDataPacket): AppleAndroidHandoffBinding {
    return copyAppleAndroidHandoffBinding({ ...row, expiresAt: Number(row.expiresAt) } as AppleAndroidHandoffBinding);
}
async function connection<T>(database: Database, action: (session: PoolConnection) => Promise<T>): Promise<T> {
    let session: PoolConnection | undefined;
    try {
        session = guardConnectionQueries(await database.getConnection());
        const result = await action(session);
        session.release();
        return result;
    } catch {
        try { session?.destroy(); } catch { /* Discard remains mandatory on an uncertain command. */ }
        throw new AppleAndroidHandoffError();
    }
}
async function transaction<T>(session: PoolConnection, action: () => Promise<T>): Promise<T> {
    await session.query({ sql: 'START TRANSACTION', timeout: TIMEOUT });
    try {
        const result = await action();
        await session.query({ sql: 'COMMIT', timeout: TIMEOUT });
        return result;
    } catch (error) {
        try { await session.query({ sql: 'ROLLBACK', timeout: TIMEOUT }); } catch { /* Outer owner discards the session. */ }
        throw error;
    }
}
async function namedLock<T>(session: PoolConnection, name: string, busy: T, action: () => Promise<T>): Promise<T> {
    const [locks] = await session.query<RowDataPacket[]>({ sql: `SELECT GET_LOCK(${name}, 5) AS acquired`, timeout: TIMEOUT });
    if (locks[0]?.acquired === 0) return busy;
    if (locks[0]?.acquired !== 1) throw new AppleAndroidHandoffError();
    try { return await action(); }
    finally {
        const [released] = await session.query<RowDataPacket[]>({ sql: `SELECT RELEASE_LOCK(${name}) AS released`, timeout: TIMEOUT });
        if (released[0]?.released !== 1) throw new AppleAndroidHandoffError();
    }
}
async function lockAttempt(session: PoolConnection, value: AppleAndroidHandoffBinding): Promise<boolean> {
    // Parent first matches normal attempt deletion's FK cascade order. Its deadline may outlive
    // the anonymous cookie's shorter handoff deadline, but every other bound field must match.
    const [rows] = await session.query<RowDataPacket[]>({ sql: `SELECT state_hash FROM provider_auth_attempts
        WHERE ${MATCH.replace('expires_at =', 'expires_at >=')} AND expires_at > UTC_TIMESTAMP(6)
        LIMIT 1 FOR UPDATE`, timeout: TIMEOUT }, values(value));
    if (rows.length > 1) throw new AppleAndroidHandoffError();
    return rows.length === 1;
}

/** Expired ciphertext is removed without loading signing or encryption credentials. */
export async function cleanupAppleAndroidHandoffs(database: Database): Promise<{ deleted: number; backlog: boolean }> {
    return connection(database, session => namedLock(session, PARENT_CREATION_LOCK, { deleted: 0, backlog: true }, async () => {
        let deleted = 0;
        for (let batch = 0; batch < 10; batch++) {
            const [result] = await session.query<ResultSetHeader>({ sql: 'DELETE FROM apple_android_handoffs WHERE expires_at <= UTC_TIMESTAMP(6) ORDER BY expires_at LIMIT 100', timeout: TIMEOUT });
            if (!Number.isInteger(result.affectedRows) || result.affectedRows < 0 || result.affectedRows > 100) throw new AppleAndroidHandoffError();
            deleted += result.affectedRows;
            if (result.affectedRows < 100) return { deleted, backlog: false };
        }
        const [rows] = await session.query<RowDataPacket[]>({ sql: 'SELECT state_hash FROM apple_android_handoffs WHERE expires_at <= UTC_TIMESTAMP(6) LIMIT 1', timeout: TIMEOUT });
        return { deleted, backlog: rows.length !== 0 };
    }));
}

/** Adapters supply trusted native context; only a verified Apple callback may complete a pending row. */
export function createAppleAndroidHandoffRepository(database: Database, cipher: Cipher) {
    return Object.freeze({
        async readAttempt(stateHash: Buffer, bindingHash: Buffer): Promise<AppleAndroidHandoffBinding | null> {
            if (![stateHash, bindingHash].every(value => Buffer.isBuffer(value) && value.length === 32)) throw new AppleAndroidHandoffError();
            const params = [Buffer.from(stateHash), Buffer.from(bindingHash)];
            return connection(database, async session => {
                const [rows] = await session.query<RowDataPacket[]>({ sql: `SELECT ${COLUMNS} FROM provider_auth_attempts
                    WHERE state_hash = ? AND binding_hash = ? AND BINARY client_key = BINARY 'apple-android'
                        AND expires_at > UTC_TIMESTAMP(6) LIMIT 1`, timeout: TIMEOUT }, params);
                return rows.length === 0 ? null : rowBinding(rows[0]);
            });
        },
        async create(input: AppleAndroidHandoffBinding): Promise<'created' | 'busy'> {
            const value = copyAppleAndroidHandoffBinding(input);
            return connection(database, session => namedLock<'created' | 'busy'>(session, PARENT_CREATION_LOCK, 'busy',
                () => namedLock<'created' | 'busy'>(session, LOCK, 'busy', async () => {
                    // Global expired-child cleanup is a separate bounded autocommit statement;
                    // it must not hold an unrelated attempt's parent lock while visiting other rows.
                    await session.query({ sql: 'SET SESSION autocommit = 1', timeout: TIMEOUT });
                    await session.query({ sql: 'DELETE FROM apple_android_handoffs WHERE expires_at <= UTC_TIMESTAMP(6) ORDER BY expires_at LIMIT 100', timeout: TIMEOUT });
                    return await transaction(session, async () => {
                        if (!await lockAttempt(session, value)) return 'busy';
                        await session.query({ sql: 'DELETE FROM apple_android_handoffs WHERE binding_hash = ?', timeout: TIMEOUT }, [value.bindingHash]);
                        const [rows] = await session.query<RowDataPacket[]>({ sql: `SELECT COUNT(*) AS pendingCount FROM
                            (SELECT state_hash FROM apple_android_handoffs LIMIT ${APPLE_ANDROID_HANDOFF_CAP}) AS bounded_handoffs`, timeout: TIMEOUT });
                        const count = rows[0]?.pendingCount;
                        if (!Number.isSafeInteger(count) || count < 0 || count > APPLE_ANDROID_HANDOFF_CAP) throw new AppleAndroidHandoffError();
                        if (count === APPLE_ANDROID_HANDOFF_CAP) return 'busy';
                        const [inserted] = await session.query<ResultSetHeader>({ sql: `INSERT INTO apple_android_handoffs
                            (state_hash, binding_hash, nonce, client_key, action, account_uuid, user_id, phase, created_at, expires_at)
                            SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', UTC_TIMESTAMP(6), CAST(? AS DATETIME(6))
                            WHERE CAST(? AS DATETIME(6)) > UTC_TIMESTAMP(6)
                                AND CAST(? AS DATETIME(6)) <= TIMESTAMPADD(SECOND, 300, UTC_TIMESTAMP(6))`, timeout: TIMEOUT },
                        [...values(value), utc(value.expiresAt), utc(value.expiresAt)]);
                        if (inserted.affectedRows !== 0 && inserted.affectedRows !== 1) throw new AppleAndroidHandoffError();
                        return inserted.affectedRows === 1 ? 'created' : 'busy';
                    });
                })));
        },
        async readPending(stateHash: Buffer): Promise<AppleAndroidHandoffBinding | null> {
            if (!Buffer.isBuffer(stateHash) || stateHash.length !== 32) throw new AppleAndroidHandoffError();
            const state = Buffer.from(stateHash);
            return connection(database, async session => {
                const [rows] = await session.query<RowDataPacket[]>({ sql: `SELECT ${COLUMNS} FROM apple_android_handoffs
                    WHERE state_hash = ? AND phase = 'pending' AND expires_at > UTC_TIMESTAMP(6) LIMIT 1`, timeout: TIMEOUT }, [state]);
                return rows.length === 0 ? null : rowBinding(rows[0]);
            });
        },
        async readReady(stateHash: Buffer, bindingHash: Buffer): Promise<AppleAndroidHandoffBinding | null> {
            if (![stateHash, bindingHash].every(value => Buffer.isBuffer(value) && value.length === 32)) throw new AppleAndroidHandoffError();
            const params = [Buffer.from(stateHash), Buffer.from(bindingHash)];
            return connection(database, async session => {
                const [rows] = await session.query<RowDataPacket[]>({ sql: `SELECT ${COLUMNS} FROM apple_android_handoffs
                    WHERE state_hash = ? AND binding_hash = ? AND phase = 'ready'
                        AND expires_at > UTC_TIMESTAMP(6) LIMIT 1`, timeout: TIMEOUT }, params);
                return rows.length === 0 ? null : rowBinding(rows[0]);
            });
        },
        async cancelPending(input: AppleAndroidHandoffBinding): Promise<boolean> {
            const value = copyAppleAndroidHandoffBinding(input);
            return connection(database, async session => {
                const [result] = await session.query<ResultSetHeader>({ sql: `DELETE FROM apple_android_handoffs
                    WHERE ${MATCH} AND phase = 'pending' AND expires_at > UTC_TIMESTAMP(6)`, timeout: TIMEOUT }, values(value));
                if (result.affectedRows !== 0 && result.affectedRows !== 1) throw new AppleAndroidHandoffError();
                return result.affectedRows === 1;
            });
        },
        async completeCallback(input: AppleAndroidHandoffBinding, credential: AppleAndroidHandoffCredential): Promise<string | null> {
            const value = copyAppleAndroidHandoffBinding(input);
            const encrypted = cipher.encrypt(value, credential);
            return connection(database, async session => {
                const [result] = await session.query<ResultSetHeader>({ sql: `UPDATE apple_android_handoffs
                    SET phase = 'ready', encrypted_credential = ? WHERE ${MATCH}
                    AND phase = 'pending' AND expires_at > UTC_TIMESTAMP(6)`, timeout: TIMEOUT }, [encrypted, ...values(value)]);
                if (result.affectedRows !== 0 && result.affectedRows !== 1) throw new AppleAndroidHandoffError();
                return result.affectedRows === 1 ? createHash('sha256').update(encrypted).digest('base64url') : null;
            });
        },
        async redeem(input: AppleAndroidHandoffBinding, proof: string): Promise<AppleAndroidHandoffCredential | null> {
            const value = copyAppleAndroidHandoffBinding(input);
            if (typeof proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(proof)
                || Buffer.from(proof, 'base64url').toString('base64url') !== proof) return null;
            const expectedProof = Buffer.from(proof, 'base64url');
            const encrypted = await connection(database, session => transaction(session, async () => {
                if (!await lockAttempt(session, value)) return null;
                const [rows] = await session.query<RowDataPacket[]>({ sql: `SELECT encrypted_credential FROM apple_android_handoffs
                    WHERE ${MATCH} AND phase = 'ready' AND expires_at > UTC_TIMESTAMP(6) LIMIT 1 FOR UPDATE`, timeout: TIMEOUT }, values(value));
                if (rows.length === 0) return null;
                if (rows.length !== 1 || !Buffer.isBuffer(rows[0].encrypted_credential)) throw new AppleAndroidHandoffError();
                // State is known to the initiator. The unpredictable envelope receipt proves capture of
                // the verified HTTPS return, so a cookie holder cannot merely poll by state.
                if (!timingSafeEqual(createHash('sha256').update(rows[0].encrypted_credential).digest(), expectedProof)) return null;
                const [removed] = await session.query<ResultSetHeader>({ sql: `DELETE FROM apple_android_handoffs
                    WHERE state_hash = ? AND phase = 'ready' AND expires_at > UTC_TIMESTAMP(6)`, timeout: TIMEOUT }, [value.stateHash]);
                if (removed.affectedRows !== 0 && removed.affectedRows !== 1) throw new AppleAndroidHandoffError();
                return removed.affectedRows === 1 ? Buffer.from(rows[0].encrypted_credential) : null;
            }));
            // No credential is decrypted or returned before committed one-use removal.
            return encrypted === null ? null : cipher.decrypt(value, encrypted);
        },
        async cleanupExpired(): Promise<{ deleted: number; backlog: boolean }> {
            return cleanupAppleAndroidHandoffs(database);
        },
    });
}
