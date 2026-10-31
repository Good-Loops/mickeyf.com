import assert from 'node:assert/strict';
import test from 'node:test';
import { DELETION_REPLAY_FREEZE_ACK, DELETION_REPLAY_RECOVERY_ACK, loadDeletionReplayConfig } from './deletionReplayConfig';

const ENV = {
    DELETION_REPLAY_MODE: 'recovery',
    DELETION_REPLAY_FREEZE_ACK,
    DELETION_REPLAY_RECOVERY_ACK,
    DELETION_REPLAY_DB_HOST: '127.0.0.1',
    DELETION_REPLAY_DB_PORT: '3317',
    DELETION_REPLAY_DB_NAME: 'isolated_recovery',
    DELETION_REPLAY_DB_USER: 'recovery_operator',
    DELETION_REPLAY_DB_PASSWORD: ' test-only-password ',
    DELETION_REPLAY_DB_CURRENT_USER: 'recovery_operator@%',
    DELETION_REPLAY_DB_SERVER_UUID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    DELETION_REPLAY_SOURCE_SERVER_UUID: 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff',
    DELETION_REPLAY_IDENTITY_EPOCH: '2026-09-11 12:13:14.123456',
};

test('requires only dedicated explicit connection pins and preserves the secret without logging it', () => {
    const config = loadDeletionReplayConfig(['plan'], ENV);
    assert.equal(config.connection.host, '127.0.0.1');
    assert.equal(config.connection.port, 3317);
    assert.equal(config.connection.password, ' test-only-password ');
    assert.equal(config.settings.expectedIdentityEpoch, ENV.DELETION_REPLAY_IDENTITY_EPOCH);
    assert.equal(config.settings.maxIntents, 1000);
    assert.equal(config.settings.maxDurationMs, 60000);
    assert.equal(config.approvedPlanSha256, undefined);
    assert.throws(() => loadDeletionReplayConfig(['plan'], {
        DB_HOST: '127.0.0.1', DB_PORT: '3317', DB_NAME: 'cms', DB_USER: 'root', DB_PASS: 'ignored',
    }), /Missing/u);
});

test('accepts exact Cloud SQL proxy account hosts without relaxing the maintenance username', () => {
    for (const host of ['cloudsqlproxy~%', 'cloudsqlproxy~198.51.100.23']) {
        const currentUser = `${ENV.DELETION_REPLAY_DB_USER}@${host}`;
        const config = loadDeletionReplayConfig(['plan'], {
            ...ENV, DELETION_REPLAY_DB_CURRENT_USER: currentUser,
        });
        assert.equal(config.settings.expectedCurrentUser, currentUser);
    }
    assert.throws(() => loadDeletionReplayConfig(['plan'], {
        ...ENV,
        DELETION_REPLAY_DB_USER: 'recovery~operator',
        DELETION_REPLAY_DB_CURRENT_USER: 'recovery~operator@cloudsqlproxy~%',
    }), /maintenance user/u);
    assert.throws(() => loadDeletionReplayConfig(['plan'], {
        ...ENV, DELETION_REPLAY_DB_CURRENT_USER: 'recovery_operator@cloudsqlproxy~%;',
    }), /CURRENT_USER/u);
});

test('rejects missing pins, aliases, same-source recovery, invalid epoch and missing attestations', () => {
    for (const change of [
        { DELETION_REPLAY_DB_HOST: 'localhost' },
        { DELETION_REPLAY_DB_HOST: 'production.example.test' },
        { DELETION_REPLAY_DB_PORT: '' },
        { DELETION_REPLAY_DB_PORT: '3306.5' },
        { DELETION_REPLAY_DB_PORT: '65536' },
        { DELETION_REPLAY_DB_CURRENT_USER: 'other@%' },
        { DELETION_REPLAY_SOURCE_SERVER_UUID: ENV.DELETION_REPLAY_DB_SERVER_UUID },
        { DELETION_REPLAY_DB_SERVER_UUID: '' },
        { DELETION_REPLAY_IDENTITY_EPOCH: '2026-09-11 12:13:14' },
        { DELETION_REPLAY_IDENTITY_EPOCH: '2026-02-30 12:13:14.123456' },
        { DELETION_REPLAY_FREEZE_ACK: '' },
        { DELETION_REPLAY_RECOVERY_ACK: '' },
        { DELETION_REPLAY_MODE: 'automatic' },
        { DELETION_REPLAY_DB_NAME: 'cms; DROP DATABASE cms' },
        { DELETION_REPLAY_MAX_INTENTS: '10001' },
        { DELETION_REPLAY_MAX_DURATION_MS: '300001' },
    ]) assert.throws(() => loadDeletionReplayConfig(['plan'], { ...ENV, ...change }));
});

test('apply requires reviewed digest; active replay still requires a write freeze', () => {
    assert.throws(() => loadDeletionReplayConfig(['apply'], ENV), /reviewed/u);
    const config = loadDeletionReplayConfig(['apply'], {
        ...ENV, DELETION_REPLAY_APPROVED_PLAN_SHA256: 'a'.repeat(64),
    });
    assert.equal(config.approvedPlanSha256, 'a'.repeat(64));
    assert.throws(() => loadDeletionReplayConfig(['plan'], {
        ...ENV, DELETION_REPLAY_APPROVED_PLAN_SHA256: 'a'.repeat(64),
    }), /must not include/u);
    const active = { ...ENV, DELETION_REPLAY_MODE: 'active', DELETION_REPLAY_SOURCE_SERVER_UUID: undefined };
    assert.equal(loadDeletionReplayConfig(['plan'], active).settings.mode, 'active');
    assert.throws(() => loadDeletionReplayConfig(['plan'], { ...active, DELETION_REPLAY_FREEZE_ACK: '' }));
    assert.throws(() => loadDeletionReplayConfig(['plan'], { ...ENV, DELETION_REPLAY_MODE: 'active' }));
    assert.throws(() => loadDeletionReplayConfig(['plan', '--force'], ENV));
});
