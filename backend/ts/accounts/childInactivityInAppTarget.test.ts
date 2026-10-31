import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { createInAppInactivityQualityResolver } from './childInactivityInAppTarget';

const parent = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const connection = {} as PoolConnection;

test('in-app binding is private, channel-specific and tied to both account identities', async () => {
    const resolve = createInAppInactivityQualityResolver(Buffer.alloc(32, 8), async () => true);
    const a = await resolve(connection, parent, child);
    assert.equal(a.channel, 'in-app'); assert.equal(a.activityComplete, true);
    assert.match(a.currentTargetDigest!, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(a).includes(parent), false);
    assert.equal((await resolve(connection, parent, child)).currentTargetDigest, a.currentTargetDigest);
    assert.notEqual((await resolve(connection, parent, other)).currentTargetDigest, a.currentTargetDigest);
    assert.notEqual((await resolve(connection, other, child)).currentTargetDigest, a.currentTargetDigest);
    assert.notEqual((await createInAppInactivityQualityResolver(Buffer.alloc(32, 9), async () => true)(connection, parent, child)).currentTargetDigest, a.currentTargetDigest);
});

test('missing health, bad identities and bad keys never establish activity completeness', async () => {
    assert.throws(() => createInAppInactivityQualityResolver(Buffer.alloc(31), async () => true));
    const unknown = createInAppInactivityQualityResolver(Buffer.alloc(32), async () => false);
    assert.equal((await unknown(connection, parent, child)).activityComplete, false);
    await assert.rejects(unknown(connection, parent, parent));
    const unavailable = createInAppInactivityQualityResolver(Buffer.alloc(32), async () => { throw new Error('unavailable'); });
    await assert.rejects(unavailable(connection, parent, child));
});
