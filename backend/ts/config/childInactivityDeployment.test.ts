import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CHILD_RETENTION_BUCKET, loadChildInactivityDeployment } from './childInactivityDeployment';

const valid = { NODE_ENV: 'production', CHILD_INACTIVITY_ENABLED: 'true', CHILD_ONLINE_ACTIVITY_ENABLED: 'true',
    ACCOUNT_DELETION_ENABLED: 'true', APPLE_MAINTENANCE_HTTP_ENABLED: 'true', CHILD_RETENTION_BUCKET,
    DB_NAME: 'synthetic_db', APPLE_MAINTENANCE_EXPECTED_SERVER_UUID: '11111111-1111-4111-8111-111111111111',
    CHILD_INACTIVITY_KEYS: `${'11'.repeat(32)}:${'22'.repeat(32)}:${'33'.repeat(32)}` };

test('inactivity deployment is opt-in and requires exact production dependencies', () => {
    assert.equal(loadChildInactivityDeployment({}), undefined);
    assert.equal(loadChildInactivityDeployment({ CHILD_INACTIVITY_ENABLED: 'false' }), undefined);
    assert.equal(loadChildInactivityDeployment(valid)?.bucket, CHILD_RETENTION_BUCKET);
    for (const patch of [{ CHILD_INACTIVITY_ENABLED: 'yes' }, { NODE_ENV: 'development' },
        { CHILD_ONLINE_ACTIVITY_ENABLED: 'false' }, { ACCOUNT_DELETION_ENABLED: 'false' },
        { APPLE_MAINTENANCE_HTTP_ENABLED: 'false' }, { CHILD_RETENTION_BUCKET: 'other-bucket' },
        { DB_NAME: 'invalid/name' }, { APPLE_MAINTENANCE_EXPECTED_SERVER_UUID: 'invalid' }]) {
        assert.throws(() => loadChildInactivityDeployment({ ...valid, ...patch }));
    }
});

test('independent exact-length secret keys are mandatory', () => {
    for (const patch of [{ CHILD_INACTIVITY_KEYS: '' }, { CHILD_INACTIVITY_KEYS: 'x'.repeat(194) },
        { CHILD_INACTIVITY_KEYS: `${'11'.repeat(32)}:${'22'.repeat(32)}:${'33'.repeat(31)}` },
        { CHILD_INACTIVITY_KEYS: `${'11'.repeat(32)}:${'22'.repeat(32)}:${'22'.repeat(32)}` },
        { CHILD_INACTIVITY_KEYS: `${'33'.repeat(32)}:${'22'.repeat(32)}:${'33'.repeat(32)}` }]) {
        assert.throws(() => loadChildInactivityDeployment({ ...valid, ...patch }));
    }
});
