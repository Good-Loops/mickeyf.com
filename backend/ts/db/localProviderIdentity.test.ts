import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { verifyLocalProviderIdentity } from './localProviderIdentity';
import { LOCAL_PROVIDER_SERVER_UUID } from '../config/localProviderRuntime';

const identity = { expectedServerUuid: LOCAL_PROVIDER_SERVER_UUID, expectedAccount: 'cms_mickeyf@%', maintenanceEnabled: true };
const row = { databaseName: 'cms', currentUser: 'cms_mickeyf@%', serverUuid: LOCAL_PROVIDER_SERVER_UUID };

function fixture(result: unknown = [row]) {
    const state = { released: 0, destroyed: 0, queries: [] as string[] };
    const connection = { async query(options: { sql: string; timeout: number }) {
        state.queries.push(options.sql);
        assert.equal(options.timeout, 10_000);
        return [result, []];
    }, release() { state.released++; }, destroy() { state.destroyed++; } } as unknown as PoolConnection;
    return { state, database: { async getConnection() { return connection; } } as Pick<Pool, 'getConnection'> };
}

test('local identity gate reads only the database, effective account and exact server identity', async () => {
    const f = fixture();
    await verifyLocalProviderIdentity(f.database, identity);
    assert.equal(f.state.queries.length, 1);
    assert.match(f.state.queries[0], /^SELECT DATABASE\(\)/);
    assert.equal(f.state.released, 1);
    assert.equal(f.state.destroyed, 0);
});

test('unavailable or wrong target never passes local credential readiness or reuses the connection', async () => {
    for (const result of [[], [row, row], [{ ...row, databaseName: 'other' }], [{ ...row, currentUser: 'root@%' }],
        [{ ...row, serverUuid: 'another-server' }], {}, null]) {
        const f = fixture(result);
        await assert.rejects(verifyLocalProviderIdentity(f.database, identity),
            { message: 'Local provider database identity could not be verified.' });
        assert.equal(f.state.released, 0);
        assert.equal(f.state.destroyed, 1);
    }
});
