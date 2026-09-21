import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { APPLE_TOKEN_MIGRATION_VERSION } from '../migrations/appleTokenSchema';
import { assertAccountId, parseDeletionIntent } from './deletionJournal';

type TokenConnection = Pick<PoolConnection, 'query'>;
export type StoredAppleToken = Readonly<{
    token_id: string; account_uuid: string; client_id: string; encrypted_token: Buffer;
}>;
export type PreparedAppleToken = StoredAppleToken;
export type AppleTokenEncryptionSettings = Readonly<{
    clientId: string; activeKeyId: string; encryptionKeys: Readonly<Record<string, Buffer>>;
}>;

const QUERY_TIMEOUT_MS = 10_000;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}(?![\s\S])/u;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}(?![\s\S])/u;
const TOKEN = /^[\x21-\x7e]{1,4096}(?![\s\S])/u;
const VERSION = 1;

export class AppleTokenStorageError extends Error {
    constructor() { super('Apple token storage could not be confirmed.'); this.name = 'AppleTokenStorageError'; }
}

function associatedData(row: Omit<StoredAppleToken, 'encrypted_token'>, keyId: string): Buffer {
    if (typeof row.token_id !== 'string' || row.token_id.length !== 36
        || typeof row.account_uuid !== 'string' || row.account_uuid.length !== 36
        || typeof row.client_id !== 'string') throw new AppleTokenStorageError();
    assertAccountId(row.token_id);
    assertAccountId(row.account_uuid);
    if (!CLIENT_ID.test(row.client_id)) throw new AppleTokenStorageError();
    return Buffer.from(JSON.stringify(['apple-provider-token', VERSION, row.token_id, row.account_uuid, row.client_id, keyId]));
}

/** Encryption keys are independent of login/session keys and never stored in SQL. */
export function createAppleTokenRepository(settings: AppleTokenEncryptionSettings) {
    if (typeof settings.clientId !== 'string' || typeof settings.activeKeyId !== 'string'
        || !CLIENT_ID.test(settings.clientId) || !KEY_ID.test(settings.activeKeyId)
        || !settings.encryptionKeys || Object.keys(settings.encryptionKeys).length === 0
        || Object.entries(settings.encryptionKeys).some(([id, key]) => !KEY_ID.test(id) || !Buffer.isBuffer(key) || key.length !== 32)
        || !Object.prototype.hasOwnProperty.call(settings.encryptionKeys, settings.activeKeyId)) throw new AppleTokenStorageError();
    const keys = new Map(Object.entries(settings.encryptionKeys).map(([id, key]) => [id, Buffer.from(key)]));
    const { clientId, activeKeyId } = settings;

    function prepare(refreshToken: string, accountId: string): PreparedAppleToken {
        try {
            if (typeof refreshToken !== 'string' || !TOKEN.test(refreshToken)) throw new AppleTokenStorageError();
            const identity = { token_id: randomUUID(), account_uuid: accountId, client_id: clientId };
            const nonce = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', keys.get(activeKeyId)!, nonce);
            cipher.setAAD(associatedData(identity, activeKeyId));
            const encrypted = Buffer.concat([cipher.update(refreshToken, 'ascii'), cipher.final()]);
            const keyId = Buffer.from(activeKeyId, 'ascii');
            const envelope = Buffer.concat([Buffer.from([VERSION, keyId.length]), keyId, nonce, cipher.getAuthTag(), encrypted]);
            return Object.freeze({ ...identity, encrypted_token: envelope });
        } catch { throw new AppleTokenStorageError(); }
    }

    function decrypt(row: StoredAppleToken): string {
        try {
            const envelope = row.encrypted_token;
            if (!Buffer.isBuffer(envelope) || envelope.length > 8192 || envelope[0] !== VERSION
                || envelope[1] < 1 || envelope[1] > 64 || envelope.length <= 30 + envelope[1]) throw new AppleTokenStorageError();
            const offset = 2 + envelope[1];
            const keyId = envelope.subarray(2, offset).toString('utf8');
            const key = keys.get(keyId);
            if (!KEY_ID.test(keyId) || !key) throw new AppleTokenStorageError();
            const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(offset, offset + 12));
            decipher.setAAD(associatedData(row, keyId));
            decipher.setAuthTag(envelope.subarray(offset + 12, offset + 28));
            const token = Buffer.concat([decipher.update(envelope.subarray(offset + 28)), decipher.final()]).toString('ascii');
            if (!TOKEN.test(token)) throw new AppleTokenStorageError();
            return token;
        } catch { throw new AppleTokenStorageError(); }
    }

    /** Caller holds the account lock and transaction which establishes the Apple identity. */
    async function save(connection: TokenConnection, row: PreparedAppleToken): Promise<void> {
        try {
            decrypt(row);
            if (row.client_id !== clientId) throw new AppleTokenStorageError();
            const [result] = await connection.query<ResultSetHeader>({
                sql: `INSERT INTO apple_provider_tokens (token_id, account_uuid, client_id, encrypted_token, created_at)
                    SELECT ?, ?, ?, ?, UTC_TIMESTAMP(6) WHERE EXISTS (
                        SELECT 1 FROM account_provider_identities WHERE account_uuid = ? AND provider = 'apple')`,
                timeout: QUERY_TIMEOUT_MS,
            }, [row.token_id, row.account_uuid, row.client_id, row.encrypted_token, row.account_uuid]);
            if (result.affectedRows !== 1) throw new AppleTokenStorageError();
        } catch { throw new AppleTokenStorageError(); }
    }

    return Object.freeze({ prepare, save, decrypt, markForRevocation: markAppleTokensForRevocation });
}

/** SQL-only transition shared by every deletion method and isolated backup replay. */
export async function markAppleTokensForRevocation(
    connection: TokenConnection, accountId: string, requestedAt = new Date().toISOString(),
): Promise<void> {
    if (typeof accountId !== 'string' || accountId.length !== 36) throw new AppleTokenStorageError();
    assertAccountId(accountId);
    parseDeletionIntent({ version: 1, action: 'delete-account', accountId, requestedAt });
    const requested = requestedAt.replace('T', ' ').slice(0, -1);
    // Preserve the earliest intent, including on old restores and repeated replay.
    const intentTime = 'LEAST(CAST(? AS DATETIME(6)), UTC_TIMESTAMP(6))';
    try {
        await connection.query({
            sql: `UPDATE apple_provider_tokens SET
                revocation_requested_at = LEAST(COALESCE(revocation_requested_at, ${intentTime}), ${intentTime}),
                retention_deadline = LEAST(COALESCE(retention_deadline, TIMESTAMPADD(DAY, 7, ${intentTime})), TIMESTAMPADD(DAY, 7, ${intentTime})),
                next_attempt_at = LEAST(COALESCE(next_attempt_at, UTC_TIMESTAMP(6)), UTC_TIMESTAMP(6))
                WHERE account_uuid = ?`, timeout: QUERY_TIMEOUT_MS,
        }, [requested, requested, requested, requested, accountId]);
        await connection.query({
            sql: 'DELETE FROM apple_provider_tokens WHERE account_uuid = ? AND retention_deadline <= UTC_TIMESTAMP(6)',
            timeout: QUERY_TIMEOUT_MS,
        }, [accountId]);
    } catch (error) {
        if (!['ER_NO_SUCH_TABLE', 'ER_TABLEACCESS_DENIED_ERROR'].includes((error as { code?: string })?.code ?? '')) {
            throw new AppleTokenStorageError();
        }
        // Historical backups can predate 0016; a recorded-but-missing table is corruption.
        try {
            const [tables] = await connection.query<RowDataPacket[]>({
                sql: `SELECT COUNT(*) AS tableCount FROM information_schema.TABLES
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, timeout: QUERY_TIMEOUT_MS,
            }, ['apple_provider_tokens']);
            if (!Array.isArray(tables) || tables.length !== 1 || Number(tables[0].tableCount) !== 0) throw new AppleTokenStorageError();
            const [recorded] = await connection.query<RowDataPacket[]>({
                sql: 'SELECT version FROM schema_migrations WHERE version = ?', timeout: QUERY_TIMEOUT_MS,
            }, [APPLE_TOKEN_MIGRATION_VERSION]);
            if (!Array.isArray(recorded) || recorded.length !== 0) throw new AppleTokenStorageError();
        } catch { throw new AppleTokenStorageError(); }
    }
}
