import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test } from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { createAppleTokenRepository, type PreparedAppleToken } from '../accounts/appleTokenRepository';
import type { VerifiedProviderIdentity } from './providerIdentity';
import { stageAppleCredential } from './stagedAppleCredential';

const token = 'synthetic-refresh-token';
const account = { userId: 7, accountId: '11111111-2222-4333-8444-555555555555', userName: 'synthetic' };
const identity = { provider: 'apple', subject: 'synthetic-subject', appleClientId: 'com.example.test', appleIssuedAt: 1_800_000_000 } as VerifiedProviderIdentity;
const proof = { subject: identity.subject, clientId: identity.appleClientId!, issuedAt: identity.appleIssuedAt! };
const connection = {} as PoolConnection;

function fixture() {
    const actual = createAppleTokenRepository({ clientId: 'com.example.test', activeKeyId: 'v1', encryptionKeys: { v1: Buffer.alloc(32, 3) } });
    let prepared: PreparedAppleToken | undefined;
    let writes = 0;
    const repository = { ...actual,
        prepare(value: string, accountId: string) { return prepared = actual.prepare(value, accountId); },
        async save(_connection: Pick<PoolConnection, 'query'>, row: PreparedAppleToken) { assert.equal(row, prepared); writes++; },
    };
    const staged = stageAppleCredential(repository, account, identity, token);
    return { staged, prepared: () => prepared!, writes: () => writes };
}

test('staging performs no write, exposes no token and disposes the encrypted buffer after one write', async () => {
    const f = fixture();
    assert.equal(f.writes(), 0);
    assert.ok(!JSON.stringify(f.staged).includes(token));
    assert.ok(!inspect(f.staged, { showHidden: true }).includes(token));
    await f.staged.write(connection, account, proof);
    assert.equal(f.writes(), 1);
    await assert.rejects(f.staged.write(connection, account, proof));
    f.staged.dispose(); f.staged.dispose();
    assert.ok(f.prepared().encrypted_token.every(byte => byte === 0));
    await assert.rejects(f.staged.write(connection, account, proof));
});

test('staged credentials reject a changed account, Apple subject, client or issuance time before any write', async () => {
    for (const [target, changedProof] of [
        [{ ...account, userId: 8 }, proof],
        [{ ...account, accountId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, proof],
        [account, { ...proof, subject: 'other-subject' }],
        [account, { ...proof, clientId: 'other-client' }],
        [account, { ...proof, issuedAt: proof.issuedAt + 1 }],
    ] as const) {
        const f = fixture();
        await assert.rejects(f.staged.write(connection, target, changedProof));
        assert.equal(f.writes(), 0);
        f.staged.dispose();
        assert.ok(f.prepared().encrypted_token.every(byte => byte === 0));
    }
});

test('staging rejects a repository for a different Apple client and clears its prepared buffer', () => {
    const actual = createAppleTokenRepository({ clientId: 'wrong.example.test', activeKeyId: 'v1', encryptionKeys: { v1: Buffer.alloc(32, 3) } });
    let prepared: PreparedAppleToken | undefined;
    const repository = { ...actual, prepare(value: string, accountId: string) { return prepared = actual.prepare(value, accountId); } };
    assert.throws(() => stageAppleCredential(repository, account, identity, token));
    assert.ok(prepared);
    assert.ok(prepared.encrypted_token.every(byte => byte === 0));
});
