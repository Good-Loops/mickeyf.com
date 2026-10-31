import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAccountIdentityCommandConfirmed } from './accountIdentityMigrationConfig';

const config = { host: '127.0.0.1', port: 13306, database: 'local_test' };
const confirmed = {
    MIGRATION_CONFIRM_DATABASE: 'local_test',
    MIGRATION_CONFIRM_TARGET: '127.0.0.1:13306/local_test',
    MIGRATION_ALLOW_APPLY: '1',
    MIGRATION_ALLOW_ACCOUNT_IDENTITY: '1',
    MIGRATION_CONFIRM_WRITERS_DRAINED: '1',
    MIGRATION_CONFIRM_ACCOUNT_IDENTITY_PLAN_SHA256: 'a'.repeat(64),
    MIGRATION_CONFIRM_SERVER_UUID: '00000000-0000-4000-8000-000000000001',
};

test('identity inspection requires the exact database and loopback target but no mutation permission', () => {
    for (const command of ['plan', 'verify'] as const) {
        assert.deepEqual(assertAccountIdentityCommandConfirmed(command, config, confirmed), {});
        assert.throws(() => assertAccountIdentityCommandConfirmed(command, config, {
            ...confirmed, MIGRATION_CONFIRM_TARGET: '127.0.0.1:13306/another_database',
        }), /CONFIRM_TARGET/);
    }
});

test('identity apply needs independent effect, writer-drain, server and reviewed-plan confirmations', () => {
    for (const name of Object.keys(confirmed)) {
        assert.throws(() => assertAccountIdentityCommandConfirmed('apply', config, {
            ...confirmed, [name]: undefined,
        }), new RegExp(name));
    }
    assert.deepEqual(assertAccountIdentityCommandConfirmed('apply', config, confirmed), {
        approvedPlanSha256: confirmed.MIGRATION_CONFIRM_ACCOUNT_IDENTITY_PLAN_SHA256,
        confirmedServerUuid: confirmed.MIGRATION_CONFIRM_SERVER_UUID,
    });
});
