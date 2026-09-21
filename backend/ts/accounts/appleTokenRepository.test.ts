import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolConnection, QueryOptions } from 'mysql2/promise';
import { AppleTokenStorageError, createAppleTokenRepository, markAppleTokensForRevocation } from './appleTokenRepository';

const accountId = randomUUID();
const clientId = 'com.example.apple';
const settings = { clientId, activeKeyId: 'v1', encryptionKeys: { v1: randomBytes(32) } };

test('encrypted credentials bind account, client, token ID and key ID without persisting plaintext', async () => {
    const vault = createAppleTokenRepository(settings);
    const token = 'synthetic-refresh-token';
    const first = vault.prepare(token, accountId); const second = vault.prepare(token, accountId);
    assert.equal(vault.decrypt(first), token);
    assert.notEqual(first.token_id, second.token_id);
    assert.notDeepEqual(first.encrypted_token, second.encrypted_token);
    assert.equal(first.encrypted_token.includes(Buffer.from(token)), false);
    for (const modified of [{ ...first, account_uuid: randomUUID() }, { ...first, token_id: randomUUID() },
        { ...first, client_id: 'another.client' }, { ...first, encrypted_token: Buffer.from(first.encrypted_token) }]) {
        if (modified.account_uuid === accountId && modified.token_id === first.token_id && modified.client_id === clientId) {
            modified.encrypted_token[modified.encrypted_token.length - 1] ^= 1;
        }
        assert.throws(() => vault.decrypt(modified), AppleTokenStorageError);
    }
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const connection = { async query(query: QueryOptions, values: unknown[]) {
        calls.push({ sql: query.sql, values }); return [{ affectedRows: 1 }, []];
    } } as unknown as PoolConnection;
    await vault.save(connection, first);
    assert.match(calls[0].sql, /WHERE EXISTS[\s\S]*account_provider_identities[\s\S]*provider = 'apple'/u);
    assert.equal(calls[0].values.includes(token), false);
    assert.deepEqual(calls[0].values[3], first.encrypted_token);
});

test('key rotation decrypts old envelopes, rejects missing keys and copies caller key material', () => {
    const originalKey = randomBytes(32);
    const oldVault = createAppleTokenRepository({ clientId, activeKeyId: 'old', encryptionKeys: { old: originalKey } });
    const row = oldVault.prepare('old-refresh-token', accountId);
    const nextVault = createAppleTokenRepository({ clientId, activeKeyId: 'new',
        encryptionKeys: { old: originalKey, new: randomBytes(32) } });
    originalKey.fill(0);
    assert.equal(oldVault.decrypt(row), 'old-refresh-token');
    assert.equal(nextVault.decrypt(row), 'old-refresh-token');
    assert.throws(() => createAppleTokenRepository(settings).decrypt(row), AppleTokenStorageError);
    for (const encryptionKeys of [{}, { v1: Buffer.alloc(31) }] as Array<Record<string, Buffer>>) {
        assert.throws(() => createAppleTokenRepository({ ...settings, encryptionKeys }), AppleTokenStorageError);
    }
});

test('token, client and key identifiers reject trailing newlines and other controls', () => {
    const vault = createAppleTokenRepository(settings);
    for (const suffix of ['\n', '\r', '\r\n', '\u2028']) {
        assert.throws(() => vault.prepare(`refresh-token${suffix}`, accountId), AppleTokenStorageError);
        assert.throws(() => vault.prepare('refresh-token', `${accountId}${suffix}`), AppleTokenStorageError);
        assert.throws(() => createAppleTokenRepository({ ...settings, clientId: `${clientId}${suffix}` }), AppleTokenStorageError);
        const keyId = `v1${suffix}`;
        assert.throws(() => createAppleTokenRepository({ ...settings, activeKeyId: keyId,
            encryptionKeys: { [keyId]: randomBytes(32) } }), AppleTokenStorageError);
    }
});

test('save failures are sanitized and absent links cannot retain tokens', async () => {
    const vault = createAppleTokenRepository(settings); const row = vault.prepare('refresh-token', accountId);
    for (const affectedRows of [0, 2]) {
        const connection = { async query() { return [{ affectedRows }, []]; } } as unknown as PoolConnection;
        await assert.rejects(vault.save(connection, row), AppleTokenStorageError);
    }
    const connection = { async query() { throw new Error('private token and SQL parameters'); } } as unknown as PoolConnection;
    await assert.rejects(vault.save(connection, row), error => {
        assert(error instanceof AppleTokenStorageError); assert.equal('cause' in error, false);
        assert.doesNotMatch(error.message, /private|parameters/u); return true;
    });
});

test('revocation uses earliest journal time and purges expired retained material without keys or network', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const connection = { async query(query: QueryOptions, values: unknown[]) {
        calls.push({ sql: query.sql, values }); return [{ affectedRows: 1 }, []];
    } } as unknown as PoolConnection;
    await markAppleTokensForRevocation(connection, accountId, '2026-01-02T03:04:05.000Z');
    assert.match(calls[0].sql, /LEAST\(COALESCE\(retention_deadline/u);
    assert.match(calls[0].sql, /TIMESTAMPADD\(DAY, 7,/u);
    assert.deepEqual(calls[0].values, Array(4).fill('2026-01-02 03:04:05.000').concat(accountId));
    assert.match(calls[1].sql, /^DELETE[\s\S]*retention_deadline <= UTC_TIMESTAMP/u);
    assert.deepEqual(calls[1].values, [accountId]);
});

test('only an absent unrecorded historical token table is optional', async () => {
    for (const recorded of [false, true]) {
        const connection = { async query(query: QueryOptions) {
            if (query.sql.startsWith('UPDATE')) throw Object.assign(new Error('private'), { code: 'ER_NO_SUCH_TABLE' });
            if (query.sql.includes('information_schema.TABLES')) return [[{ tableCount: 0 }], []];
            return [recorded ? [{ version: '0016_create_apple_provider_tokens' }] : [], []];
        } } as unknown as PoolConnection;
        const result = markAppleTokensForRevocation(connection, accountId);
        if (recorded) await assert.rejects(result, AppleTokenStorageError); else await result;
    }
    const denied = { async query() { throw Object.assign(new Error('private'), { code: 'ER_TABLEACCESS_DENIED_ERROR' }); } } as unknown as PoolConnection;
    await assert.rejects(markAppleTokensForRevocation(denied, accountId), AppleTokenStorageError);
});
