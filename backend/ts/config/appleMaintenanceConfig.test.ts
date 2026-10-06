import assert from 'node:assert/strict';
import test from 'node:test';
import { APPLE_MAINTENANCE_AUDIENCE, APPLE_MAINTENANCE_CALLER_EMAIL,
    APPLE_MAINTENANCE_PATH, APPLE_MAINTENANCE_URL, loadAppleMaintenanceConfig } from './appleMaintenanceConfig';

const configured = { NODE_ENV: 'production', APPLE_MAINTENANCE_HTTP_ENABLED: 'true',
    // Synthetic subject only: activation must obtain the actual service-account uniqueId.
    APPLE_MAINTENANCE_CALLER_SUBJECT: '123456789012345678901',
    APPLE_MAINTENANCE_EXPECTED_SERVER_UUID: '12345678-1234-1234-1234-123456789abc' };

test('maintenance remains absent unless its exact independent flag is true', () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1']) {
        assert.equal(loadAppleMaintenanceConfig({ APPLE_MAINTENANCE_HTTP_ENABLED: value }), undefined);
    }
});

test('enabled maintenance pins its audience and caller and requires explicit subject and database identity', () => {
    const result = loadAppleMaintenanceConfig(configured);
    assert.deepEqual(result, { audience: APPLE_MAINTENANCE_AUDIENCE,
        callerEmail: APPLE_MAINTENANCE_CALLER_EMAIL, callerSubject: configured.APPLE_MAINTENANCE_CALLER_SUBJECT,
        expectedServerUuid: configured.APPLE_MAINTENANCE_EXPECTED_SERVER_UUID });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(APPLE_MAINTENANCE_URL, `${APPLE_MAINTENANCE_AUDIENCE}${APPLE_MAINTENANCE_PATH}`);
    assert.deepEqual(loadAppleMaintenanceConfig({ ...configured, LUDOLUME_ISOLATED_RUNTIME: 'false' }), result);
});

test('activation rejects development, isolation and missing or malformed identity without echoing values', () => {
    for (const override of [
        { NODE_ENV: 'development' }, { NODE_ENV: undefined }, { LUDOLUME_ISOLATED_RUNTIME: 'true' },
        { LUDOLUME_ISOLATED_RUNTIME: '' }, { APPLE_MAINTENANCE_CALLER_SUBJECT: undefined },
        { APPLE_MAINTENANCE_CALLER_SUBJECT: 'private-invalid-value' },
        { APPLE_MAINTENANCE_CALLER_SUBJECT: '123456789012345678901 ' },
        { APPLE_MAINTENANCE_EXPECTED_SERVER_UUID: undefined },
        { APPLE_MAINTENANCE_EXPECTED_SERVER_UUID: 'private-invalid-value' },
    ]) assert.throws(() => loadAppleMaintenanceConfig({ ...configured, ...override }),
        error => error instanceof Error && error.message ===
            'Apple maintenance requires explicit production identity and database configuration.');
});
