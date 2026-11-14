import assert from 'node:assert/strict';
import test from 'node:test';
import { CHILD_ACTIVITY_CONTINUITY_BUCKET, loadChildActivityContinuity } from './childActivityContinuity';

const env = { NODE_ENV: 'production', DB_NAME: 'cms',
    APPLE_MAINTENANCE_EXPECTED_SERVER_UUID: 'd1e6865c-ecad-11ee-a6b0-42010a400002',
    CHILD_ACTIVITY_CONTINUITY_BUCKET, CHILD_ACTIVITY_CONTINUITY_KEY: '09'.repeat(32) };

test('disabled activity requires no credentials and enabled activity pins the independent store', () => {
    assert.equal(loadChildActivityContinuity({}, false), undefined);
    const result = loadChildActivityContinuity(env, true)!;
    assert.equal(result.bucket, CHILD_ACTIVITY_CONTINUITY_BUCKET);
    assert.equal(result.database, 'cms');
    assert.equal(result.serverUuid, env.APPLE_MAINTENANCE_EXPECTED_SERVER_UUID);
    assert.deepEqual(result.key, Buffer.alloc(32, 9));
});

test('enabled tracking cannot fall back after missing or invalid configuration', () => {
    for (const patch of [{ NODE_ENV: 'test' }, { DB_NAME: '' }, { DB_NAME: 'cms;SELECT 1' },
        { APPLE_MAINTENANCE_EXPECTED_SERVER_UUID: 'unknown' }, { CHILD_ACTIVITY_CONTINUITY_BUCKET: 'another-bucket' },
        { CHILD_ACTIVITY_CONTINUITY_KEY: undefined }, { CHILD_ACTIVITY_CONTINUITY_KEY: 'private-invalid-secret' },
        { CHILD_ACTIVITY_CONTINUITY_KEY: '00'.repeat(32) }]) {
        assert.throws(() => loadChildActivityContinuity({ ...env, ...patch }, true), error =>
            error instanceof Error && !error.message.includes('private-invalid-secret'));
    }
});

test('a continuity key cannot reuse either active or retired inactivity signing keys', () => {
    for (const keys of [env.CHILD_ACTIVITY_CONTINUITY_KEY,
        `active:${'08'.repeat(32)}:retired:${env.CHILD_ACTIVITY_CONTINUITY_KEY}`]) {
        assert.throws(() => loadChildActivityContinuity({ ...env, CHILD_INACTIVITY_KEYS: keys }, true), /independent/);
    }
});
