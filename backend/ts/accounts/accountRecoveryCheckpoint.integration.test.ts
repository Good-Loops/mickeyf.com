import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import mysql, { type Connection, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { establishRecoveryCheckpoint, readRecoveryCheckpoint, RecoveryCheckpointUnavailableError } from './accountRecoveryCheckpoint';
import { signJournalRetirementClaim, verifyJournalRetirementStamp } from './journalRetirementStamp';
import { DELETION_JOURNAL_BUCKET, type JournalHttpClient } from './gcsDeletionJournal';
import { createGuardedDeletionReplayReader } from './guardedDeletionReplayReader';
import { verifyDeletedAccountEffects } from './verifiedDeletionEffects';
import { verifyScoreWithdrawal } from './verifiedScoreWithdrawal';
import { verifyKeptActivity } from './verifiedKeptActivity';
import { activateRetentionGuard } from './retentionGuardActivation';
import { prepareRecoverySafeRetirement, finishRecoverySafeRetirement } from './recoverySafeRetirement';
import { inspectExplicitRetirement, retireExplicitDeletionEntry } from './retireExplicitDeletionEntry';
import type { ConditionalRetirementPair, ObservedRestoreGuard } from './gcsRetentionJournal';
import type { CloudSqlMetadataClient } from './cloudSqlRecoveryInventory';
import { createCoveredWitnessRetirement } from './coveredWitnessRetirement';
import { readRetirementKnownAccounts } from './retirementKnownAccounts';
import type { RetirementWitness } from './retirementWitnessStorage';
import { verifyRecoveryCheckpointSchema } from './recoveryCheckpointSchema';
import { applyRecoveryCheckpointSetup, planRecoveryCheckpointSetup } from './recoveryCheckpointSetup';
import { renderRuntimeGrantStatements } from '../security/runtimeGrantManifest';
import { assertKnownRecoveryWritersLocked, assertNoRetentionRuntimeWriters } from './retentionReconciliation';

const database = 'mickeyf_migration_test';
let lineage: string;
const accountId = randomUUID();
let connection: Connection;
let serverUuid: string;

before(async () => {
    const port = Number(process.env.MIGRATION_TEST_PORT);
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.MIGRATION_TEST_ENABLED, '1');
    assert.match(process.env.SYNTHETIC_REHEARSAL_CONTAINER ?? '', /^[a-f0-9]{64}$/u);
    assert.equal(process.env.MIGRATION_DB_HOST, '127.0.0.1');
    assert.equal(process.env.MIGRATION_DB_NAME, database);
    assert.equal(process.env.MIGRATION_DB_USER, 'migration_test');
    assert.equal(process.env.MIGRATION_DB_PASS, 'migration-test-only');
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535 && port !== 3306);
    for (const key of ['DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CLOUD_SQL_CONNECTION_NAME']) {
        assert.equal(process.env[key], undefined);
    }
    connection = await mysql.createConnection({ host: '127.0.0.1', port, database, user: 'migration_test',
        password: 'migration-test-only', dateStrings: true, timezone: 'Z', multipleStatements: false });
    const [identity] = await connection.query<RowDataPacket[]>(`SELECT DATABASE() AS db,CURRENT_USER() AS user,
        @@version AS version,@@version_comment AS vendor,@@GLOBAL.server_uuid AS uuid`);
    assert.equal(identity[0].db, database);
    assert.equal(identity[0].user, 'migration_test@%');
    assert.match(identity[0].version, /^8\.0\.31(?:-|$)/u);
    assert.doesNotMatch(identity[0].vendor, /Google/iu);
    serverUuid = identity[0].uuid;
    const setupGuard = { async readRestoreGuard() { return { state: 'hold' as const, database, serverUuid,
        epoch: accountId, expiresAt: '2027-01-01T00:00:00.000Z', generation: '1' }; }, async assertRestoreGuardHistory() {} };
    const setup = { connection: connection as unknown as PoolConnection,
        pins: { database, currentUser: 'migration_test@%', serverUuid }, sourceCommit: 'a'.repeat(40), guard: setupGuard,
        verifySource() {}, async verifyAccountSchema() {}, async verifyRecoveryAvailable() {}, async verifyWritersFenced() {} };
    const setupPlan = await planRecoveryCheckpointSetup(setup); lineage = setupPlan.lineage;
    await assert.rejects(applyRecoveryCheckpointSetup(setup, setupPlan, { sha256: '0'.repeat(64),
        writers: 'ORIGINAL PRIMARY AND ALL WRITERS FENCED' }));
    await applyRecoveryCheckpointSetup(setup, setupPlan, { sha256: setupPlan.sha256, writers: 'ORIGINAL PRIMARY AND ALL WRITERS FENCED' });
    await connection.query('CREATE TABLE synthetic_accounts (id INT PRIMARY KEY) ENGINE=InnoDB');
    await connection.query('INSERT INTO synthetic_accounts (id) VALUES (1)');
    await connection.query('CREATE TABLE users (account_uuid CHAR(36) PRIMARY KEY) ENGINE=InnoDB');
    await connection.query('CREATE TABLE apple_provider_tokens (account_uuid CHAR(36)) ENGINE=InnoDB');
    await connection.query('CREATE TABLE parent_registration_attempts (parent_uuid CHAR(36),child_uuid CHAR(36)) ENGINE=InnoDB');
    await connection.query('CREATE TABLE schema_migrations (version VARCHAR(255) PRIMARY KEY) ENGINE=InnoDB');
    await connection.query('CREATE TABLE parent_managed_child_activity (child_uuid CHAR(36) PRIMARY KEY) ENGINE=InnoDB');
});

after(async () => { if (connection) await connection.end(); });

test('recovery accepts a later recorded deletion of a previously kept account', async () => {
    const childId = randomUUID(), parentId = randomUUID(), originalServerUuid = randomUUID();
    const pair: ConditionalRetirementPair = { intent: { parentId, childId, warningId: randomUUID(),
        activityAt: '2023-01-01T00:00:00.000000Z', deliveredAt: '2026-10-01T00:00:00.000000Z', channel: 'in-app',
        targetDigest: 'a'.repeat(64), noticeDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64) },
        resolution: { outcome: 'kept', confirmedAt: '2026-10-02T00:00:00.000000Z',
            observedActivityAt: '2026-10-01T12:00:00.000000Z', proofDigest: 'd'.repeat(64) },
        intentObject: { name: 'synthetic-intent', generation: '1', contentSha256: 'e'.repeat(64) },
        resolutionObject: { name: 'synthetic-resolution', generation: '2', contentSha256: 'f'.repeat(64) } };
    await connection.query('CREATE TABLE parent_child_consents (child_uuid CHAR(36) PRIMARY KEY, parent_uuid CHAR(36)) ENGINE=InnoDB');
    await connection.query('ALTER TABLE parent_managed_child_activity ADD COLUMN retention_activity_at DATETIME(6)');
    try {
        let activated = false;
        const journal = { async readRestoreGuard() { return { state: 'hold' as const, database, serverUuid: originalServerUuid,
            epoch: randomUUID(), expiresAt: '2027-12-31T00:00:00.000Z', generation: '1' }; },
        async readIntents() { return [pair.intent]; }, async readResolution() { return pair.resolution; },
        async writeRestoreGuard() { activated = true; return '2'; } };
        // Keep the synthetic guard stable between reads.
        const held = await journal.readRestoreGuard(); journal.readRestoreGuard = async () => held;
        const deletionJournal = { async readDeletionIntents() { return { digest: 'a'.repeat(64), intents: [{ version: 1 as const,
            action: 'delete-account' as const, accountId: childId, requestedAt: '2026-10-03T00:00:00.000Z' }] }; } };
        const wrapped = { destroy() { connection.destroy(); }, async query(input: { sql: string }, values?: unknown[]) {
            if (input.sql === 'FLUSH TABLES WITH READ LOCK' || input.sql === 'UNLOCK TABLES') return [[], []];
            if (input.sql.includes('USER_PRIVILEGES')) return [[{ count: 1 }], []];
            if (input.sql.includes('PROCESSLIST')) return [[{ count: 0 }], []];
            return connection.query(input, values);
        } } as unknown as PoolConnection;
        assert.equal(await activateRetentionGuard(wrapped, journal, { database, serverUuid, originalServerUuid,
            currentUser: 'migration_test@%', confirmation: 'ALL WRITERS FENCED AND INTENTS RECONCILED' }, deletionJournal), '2');
        assert.equal(activated, true);
    } finally {
        await connection.query('DROP TABLE parent_child_consents');
        await connection.query('ALTER TABLE parent_managed_child_activity DROP COLUMN retention_activity_at');
    }
});

test('kept activity verifies the parent and protected time on an active account', async () => {
    const childId = randomUUID(), parentId = randomUUID();
    const pair: ConditionalRetirementPair = { intent: { parentId, childId, warningId: randomUUID(),
        activityAt: '2023-01-01T00:00:00.000000Z', deliveredAt: '2026-10-01T00:00:00.000000Z', channel: 'in-app',
        targetDigest: 'a'.repeat(64), noticeDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64) },
        resolution: { outcome: 'kept', confirmedAt: '2026-10-02T00:00:00.000000Z',
            observedActivityAt: '2026-10-01T12:00:00.000000Z', proofDigest: 'd'.repeat(64) },
        intentObject: { name: 'synthetic-intent', generation: '1', contentSha256: 'e'.repeat(64) },
        resolutionObject: { name: 'synthetic-resolution', generation: '2', contentSha256: 'f'.repeat(64) } };
    await connection.query('CREATE TABLE parent_child_consents (child_uuid CHAR(36) PRIMARY KEY, parent_uuid CHAR(36)) ENGINE=InnoDB');
    await connection.query('ALTER TABLE parent_managed_child_activity ADD COLUMN retention_activity_at DATETIME(6)');
    try {
        await connection.query('INSERT INTO users (account_uuid) VALUES (?)', [childId]);
        await connection.query('INSERT INTO parent_child_consents (child_uuid,parent_uuid) VALUES (?,?)', [childId, parentId]);
        await connection.query("INSERT INTO parent_managed_child_activity (child_uuid,retention_activity_at) VALUES (?, '2026-10-01 12:00:00.000000')", [childId]);
        const check = async () => {
            await connection.beginTransaction();
            try { return await verifyKeptActivity(connection as unknown as PoolConnection, pair); }
            finally { await connection.rollback(); }
        };
        assert.equal(await check(), true);
        await connection.query("UPDATE parent_managed_child_activity SET retention_activity_at='2026-09-30 00:00:00.000000' WHERE child_uuid=?", [childId]);
        assert.equal(await check(), false);
        await connection.query("UPDATE parent_managed_child_activity SET retention_activity_at='2026-10-03 00:00:00.000000' WHERE child_uuid=?", [childId]);
        await connection.query('UPDATE parent_child_consents SET parent_uuid=? WHERE child_uuid=?', [randomUUID(), childId]);
        assert.equal(await check(), false);
        assert.equal((await connection.query<RowDataPacket[]>('SELECT account_uuid FROM users WHERE account_uuid=?', [childId]))[0].length, 1);
    } finally {
        await connection.query('DELETE FROM parent_managed_child_activity WHERE child_uuid=?', [childId]);
        await connection.query('DELETE FROM users WHERE account_uuid=?', [childId]);
        await connection.query('DROP TABLE parent_child_consents');
        await connection.query('ALTER TABLE parent_managed_child_activity DROP COLUMN retention_activity_at');
    }
});

test('score withdrawal effects remain private and do not require deleting the account', async () => {
    const account = randomUUID();
    await connection.query(`CREATE TABLE account_score_permissions (account_uuid CHAR(36) PRIMARY KEY,
        visibility VARCHAR(10), policy_digest BINARY(32), registration_policy_version VARCHAR(64),
        country_code CHAR(2), age_band VARCHAR(16), authorizer_uuid CHAR(36)) ENGINE=InnoDB`);
    await connection.query(`CREATE TABLE parent_signed_forms (reference CHAR(36) PRIMARY KEY, child_uuid CHAR(36),
        public_approved TINYINT, public_withdrawn TINYINT) ENGINE=InnoDB`);
    await connection.query(`ALTER TABLE parent_registration_attempts ADD COLUMN purpose VARCHAR(32),
        ADD COLUMN phase VARCHAR(16), ADD COLUMN grant_hash BINARY(32), ADD COLUMN state_hash BINARY(32)`);
    try {
    await connection.query('INSERT INTO users (account_uuid) VALUES (?)', [account]);
    await connection.query("INSERT INTO account_score_permissions (account_uuid,visibility) VALUES (?, 'private')", [account]);
    await connection.query('INSERT INTO parent_signed_forms (reference,child_uuid,public_approved,public_withdrawn) VALUES (?,?,1,1)', [randomUUID(), account]);
    await connection.query("INSERT INTO parent_registration_attempts (child_uuid,purpose,phase) VALUES (?, 'publish-scores', 'cancelled')", [account]);
    const check = async () => {
        await connection.beginTransaction();
        try { return await verifyScoreWithdrawal(connection as unknown as PoolConnection, account); }
        finally { await connection.rollback(); }
    };
    assert.equal(await check(), true);
    await connection.query("UPDATE account_score_permissions SET visibility='public' WHERE account_uuid=?", [account]);
    assert.equal(await check(), false);
    await connection.query("UPDATE account_score_permissions SET visibility='private' WHERE account_uuid=?", [account]);
    await connection.query('UPDATE parent_signed_forms SET public_withdrawn=0 WHERE child_uuid=?', [account]);
    assert.equal(await check(), false);
    await connection.query('UPDATE parent_signed_forms SET public_withdrawn=1 WHERE child_uuid=?', [account]);
    await connection.query("UPDATE parent_registration_attempts SET phase='approved' WHERE child_uuid=?", [account]);
    assert.equal(await check(), false);
    assert.equal((await connection.query<RowDataPacket[]>('SELECT account_uuid FROM users WHERE account_uuid=?', [account]))[0].length, 1);
    } finally {
        await connection.query('DELETE FROM parent_registration_attempts WHERE child_uuid=?', [account]);
        await connection.query('DELETE FROM users WHERE account_uuid=?', [account]);
        await connection.query('DROP TABLE parent_signed_forms, account_score_permissions');
        await connection.query('ALTER TABLE parent_registration_attempts DROP COLUMN purpose, DROP COLUMN phase, DROP COLUMN grant_hash, DROP COLUMN state_hash');
    }
});

test('writer fence detects app, cleanup, operator and nonlocal root sessions', async () => {
    assert.equal(process.env.MIGRATION_TEST_ROOT_PASSWORD, 'migration-test-root-only');
    const port = Number(process.env.MIGRATION_TEST_PORT);
    let root: Connection | undefined = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root',
        password: 'migration-test-root-only', database, multipleStatements: false });
    let inspector: Connection | undefined, writer: Connection | undefined;
    try {
        await root.query("CREATE ROLE 'process_inspection_test'@'%'");
        await root.query("GRANT PROCESS ON *.* TO 'process_inspection_test'@'%'");
        await root.query("CREATE USER 'process_inspector_test'@'%' IDENTIFIED BY 'inspector-test-only'");
        await root.query("GRANT 'process_inspection_test'@'%' TO 'process_inspector_test'@'%'");
        await root.query("SET DEFAULT ROLE 'process_inspection_test'@'%' TO 'process_inspector_test'@'%'");
        await root.query("CREATE USER 'cms_mickeyf'@'%' IDENTIFIED BY 'writer-test-only'");
        await root.query("CREATE USER 'receipt_cleanup'@'%' IDENTIFIED BY 'writer-test-only'");
        await root.query("CREATE USER 'michel_operator'@'%' IDENTIFIED BY 'writer-test-only'");
        await root.query("CREATE USER 'ludolume_release_ops'@'%' IDENTIFIED BY 'writer-test-only'");
        inspector = await mysql.createConnection({ host: '127.0.0.1', port, user: 'process_inspector_test',
            password: 'inspector-test-only', multipleStatements: false });
        // The container sees this host connection as nonlocal, unlike provider-local root sessions.
        await assert.rejects(assertNoRetentionRuntimeWriters(inspector as unknown as PoolConnection, true), /not drained/u);
        await root.end(); root = undefined;
        for (const user of ['cms_mickeyf', 'receipt_cleanup', 'michel_operator', 'ludolume_release_ops']) {
            writer = await mysql.createConnection({ host: '127.0.0.1', port, user,
                password: 'writer-test-only', multipleStatements: false });
            await assert.rejects(assertNoRetentionRuntimeWriters(inspector as unknown as PoolConnection), /not drained/u);
            await writer.end(); writer = undefined;
        }
        await assertNoRetentionRuntimeWriters(inspector as unknown as PoolConnection);
        await inspector.query('SET ROLE NONE');
        await assert.rejects(assertNoRetentionRuntimeWriters(inspector as unknown as PoolConnection), /cannot verify/u);
    } finally {
        if (writer) await writer.end();
        if (inspector) await inspector.end();
        root ??= await mysql.createConnection({ host: '127.0.0.1', port, user: 'root',
            password: 'migration-test-root-only', database, multipleStatements: false });
        await root.query("DROP USER IF EXISTS 'cms_mickeyf'@'%'");
        await root.query("DROP USER IF EXISTS 'receipt_cleanup'@'%'");
        await root.query("DROP USER IF EXISTS 'michel_operator'@'%'");
        await root.query("DROP USER IF EXISTS 'ludolume_release_ops'@'%'");
        await root.query("DROP USER IF EXISTS 'process_inspector_test'@'%'");
        await root.query("DROP ROLE IF EXISTS 'process_inspection_test'@'%'");
        await root.end();
    }
});

test('production writer-lock check rejects unlocked or additional account hosts', async () => {
    const port = Number(process.env.MIGRATION_TEST_PORT);
    const root = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root',
        password: 'migration-test-root-only', database, multipleStatements: false });
    try {
        await root.query("CREATE USER 'cms_mickeyf'@'%' IDENTIFIED BY 'writer-test-only'");
        await root.query("CREATE USER 'receipt_cleanup'@'cloudsqlproxy~%' IDENTIFIED BY 'writer-test-only'");
        await root.query("CREATE USER 'michel_operator'@'cloudsqlproxy~%' IDENTIFIED BY 'writer-test-only'");
        await assert.rejects(assertKnownRecoveryWritersLocked(root as unknown as PoolConnection), /not locked/u);
        await root.query("ALTER USER 'cms_mickeyf'@'%' ACCOUNT LOCK");
        await root.query("ALTER USER 'receipt_cleanup'@'cloudsqlproxy~%' ACCOUNT LOCK");
        await root.query("ALTER USER 'michel_operator'@'cloudsqlproxy~%' ACCOUNT LOCK");
        await assertKnownRecoveryWritersLocked(root as unknown as PoolConnection);
        await root.query("CREATE USER 'michel_operator'@'other-host' IDENTIFIED BY 'writer-test-only' ACCOUNT LOCK");
        await assert.rejects(assertKnownRecoveryWritersLocked(root as unknown as PoolConnection), /not locked/u);
    } finally {
        await root.query("DROP USER IF EXISTS 'cms_mickeyf'@'%'");
        await root.query("DROP USER IF EXISTS 'receipt_cleanup'@'cloudsqlproxy~%'");
        await root.query("DROP USER IF EXISTS 'michel_operator'@'cloudsqlproxy~%'");
        await root.query("DROP USER IF EXISTS 'michel_operator'@'other-host'");
        await root.end();
    }
});

test('checkpoint runtime grant reads but cannot change the checkpoint', async () => {
    assert.equal(process.env.MIGRATION_TEST_ROOT_PASSWORD, 'migration-test-root-only');
    const port = Number(process.env.MIGRATION_TEST_PORT);
    const root = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root',
        password: 'migration-test-root-only', database, multipleStatements: false });
    let runtime: Connection | undefined;
    try {
        await root.query("CREATE USER 'checkpoint_runtime_test'@'%' IDENTIFIED BY 'checkpoint-test-only'");
        const statements = renderRuntimeGrantStatements(database, { user: 'checkpoint_runtime_test', host: '%' },
            'google-apple-parent-signed-recovery');
        const statement = statements.find(value => value.includes('`account_recovery_checkpoint`'));
        assert.ok(statement);
        await root.query(statement);
        runtime = await mysql.createConnection({ host: '127.0.0.1', port, user: 'checkpoint_runtime_test',
            password: 'checkpoint-test-only', database, multipleStatements: false });
        const [rows] = await runtime.query<RowDataPacket[]>('SELECT singleton_id,lineage_id,epoch FROM account_recovery_checkpoint');
        assert.equal(rows.length, 1);
        for (const sql of ['UPDATE account_recovery_checkpoint SET epoch=epoch+1',
            'DELETE FROM account_recovery_checkpoint',
            "INSERT INTO account_recovery_checkpoint (singleton_id,lineage_id,epoch) VALUES (1,'00000000-0000-4000-8000-000000000000',0)"]) {
            await assert.rejects(runtime.query(sql), (error: unknown) =>
                typeof error === 'object' && error !== null && 'code' in error
                && ['ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR'].includes(String(error.code)));
        }
    } finally {
        if (runtime) await runtime.end();
        await root.query("DROP USER IF EXISTS 'checkpoint_runtime_test'@'%'");
        await root.end();
    }
});

test('a checkpoint protects a deleted fixture across older and newer simulated SQL restores', async () => {
    await connection.query('CREATE TABLE synthetic_old_checkpoint AS SELECT * FROM account_recovery_checkpoint');
    await connection.query('CREATE TABLE synthetic_old_accounts AS SELECT * FROM synthetic_accounts');
    await connection.query('DELETE FROM synthetic_accounts WHERE id=1');
    await connection.query('INSERT INTO apple_provider_tokens (account_uuid) VALUES (?)', [accountId]);
    assert.equal(await verifyDeletedAccountEffects(connection as unknown as PoolConnection, [accountId]), false);
    await connection.query('DELETE FROM apple_provider_tokens');
    const pins = { database, currentUser: 'migration_test@%', serverUuid, lineage, minimumEpoch: '0' };
    const checkpoint = await establishRecoveryCheckpoint(connection as unknown as PoolConnection, pins, async transaction => {
        const [rows] = await transaction.query<RowDataPacket[]>('SELECT id FROM synthetic_accounts WHERE id=1');
        return rows.length === 0 && await verifyDeletedAccountEffects(transaction, [accountId]);
    });
    assert.equal(checkpoint.epoch, '1');
    assert.match(checkpoint.committedBefore, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u);
    await connection.query('CREATE TABLE synthetic_new_checkpoint AS SELECT * FROM account_recovery_checkpoint');
    await connection.query('CREATE TABLE synthetic_new_accounts AS SELECT * FROM synthetic_accounts');

    const guard = { ...pins, minimumEpoch: checkpoint.epoch };
    const keys = generateKeyPairSync('ed25519');
    const claim = { version: 1, bucket: DELETION_JOURNAL_BUCKET, name: 'v1/intents/42272598-9d28-457d-a63d-e3e3cd0d2a00.json', generation: '123',
        contentSha256: 'a'.repeat(64), effectConfirmedAt: '2026-01-01T00:00:00.000000Z',
        recoveryFloor: '2026-01-02T00:00:00.000000Z', checkpointLineage: lineage,
        checkpointEpoch: checkpoint.epoch, signedAt: '2026-01-03T00:00:00.000000Z' };
    const stamp = signJournalRetirementClaim(claim, keys.privateKey);
    const guarded = { async readRestoreGuard() { return { state: 'hold' as const, database, serverUuid,
        epoch: lineage, expiresAt: '2027-01-01T00:00:00.000Z', generation: '1',
        recoveryCheckpoint: { lineage, minimumEpoch: checkpoint.epoch, keySha256: createHash('sha256')
            .update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex') } }; } };
    const recoveryPins = { database, currentUser: pins.currentUser, targetServerUuid: serverUuid, originalServerUuid: serverUuid };
    const deletedObject = { bucket: claim.bucket, name: claim.name, generation: claim.generation,
        softDeleteTime: '2026-01-03T01:00:00.000Z', metadata: { ludolumeRetirement: JSON.stringify(stamp) } };
    async function reader(softDeleted: unknown[]) {
        const client: JournalHttpClient = { async request(request) { return { status: 200,
            data: { kind: 'storage#objects', items: request.params.softDeleted ? softDeleted : [] } }; } };
        const pinnedConnection = Object.assign(connection, { release() {} }) as unknown as PoolConnection;
        return createGuardedDeletionReplayReader({ database: { async getConnection() { return pinnedConnection; } },
            guard: guarded, pins: recoveryPins, publicKey: keys.publicKey, client, readTimeoutMs: 60_000 });
    }

    // Recreate the older snapshot in this disposable database, including the deleted fixture.
    await connection.query('DELETE FROM account_recovery_checkpoint');
    await connection.query('INSERT INTO account_recovery_checkpoint SELECT * FROM synthetic_old_checkpoint');
    await connection.query('INSERT INTO synthetic_accounts SELECT * FROM synthetic_old_accounts');
    assert.equal((await connection.query<RowDataPacket[]>('SELECT id FROM synthetic_accounts'))[0].length, 1);
    await assert.rejects(readRecoveryCheckpoint(connection as unknown as PoolConnection, guard), RecoveryCheckpointUnavailableError);
    await assert.rejects((await reader([])).readDeletionIntents()); // Guard still protects after soft-delete expiry.

    // Recreate the post-checkpoint snapshot: the fixture remains deleted and the signed stamp matches.
    await connection.query('DELETE FROM account_recovery_checkpoint');
    await connection.query('INSERT INTO account_recovery_checkpoint SELECT * FROM synthetic_new_checkpoint');
    await connection.query('DELETE FROM synthetic_accounts');
    await connection.query('INSERT INTO synthetic_accounts SELECT * FROM synthetic_new_accounts');
    const restored = await readRecoveryCheckpoint(connection as unknown as PoolConnection, guard);
    assert.equal((await connection.query<RowDataPacket[]>('SELECT id FROM synthetic_accounts'))[0].length, 0);
    assert.doesNotThrow(() => verifyJournalRetirementStamp(stamp, { bucket: claim.bucket, name: claim.name,
        generation: claim.generation, checkpointLineage: restored.lineage, checkpointEpoch: restored.epoch,
        observedAt: '2026-11-05T00:00:00.000000Z' }, keys.publicKey));
    assert.deepEqual((await (await reader([deletedObject])).readDeletionIntents()).intents, []);
    await assert.rejects((await reader([{ ...deletedObject, metadata: {} }])).readDeletionIntents());
});

test('guarded cleanup rejects a simulated older restore after a signed exact-generation retirement', async () => {
    // Each scenario starts from the initial checkpoint even when the full file runs.
    await connection.query('UPDATE account_recovery_checkpoint SET epoch=0 WHERE singleton_id=1');
    await verifyRecoveryCheckpointSchema(connection as unknown as PoolConnection);
    await connection.query('ALTER TABLE account_recovery_checkpoint DROP CHECK chk_account_recovery_checkpoint_singleton');
    await assert.rejects(verifyRecoveryCheckpointSchema(connection as unknown as PoolConnection));
    await connection.query('ALTER TABLE account_recovery_checkpoint ADD CONSTRAINT chk_account_recovery_checkpoint_singleton CHECK (singleton_id = 1)');
    await verifyRecoveryCheckpointSchema(connection as unknown as PoolConnection);
    const keys = generateKeyPairSync('ed25519');
    const account = randomUUID();
    const intent = { version: 1 as const, action: 'delete-account' as const, accountId: account, requestedAt: '2026-01-01T00:00:00.000Z' };
    const body = JSON.stringify(intent);
    const entry = { name: 'v1/intents/42272598-9d28-457d-a63d-e3e3cd0d2a00.json', generation: '123',
        contentSha256: createHash('sha256').update(body).digest('hex'), intent };
    const pins = { database, currentUser: 'migration_test@%', serverUuid };
    let floorMs = Date.now() + 10 * 24 * 60 * 60_000;
    let nowMs = floorMs + 2 * 24 * 60 * 60_000;
    let floor = new Date(floorMs).toISOString(), future = new Date(nowMs).toISOString();
    let nowUtc = future.replace('Z', '000Z');
    const wrapped = { async beginTransaction() { await connection.beginTransaction(); }, async commit() { await connection.commit(); },
        async rollback() { await connection.rollback(); }, destroy() { connection.destroy(); }, async query(input: { sql: string }, values?: unknown[]) {
            if (input.sql.includes('USER_PRIVILEGES')) return [[{ count: 1 }], []];
            if (input.sql.includes('PROCESSLIST')) return [[{ count: 0 }], []];
            const [rows, fields] = await connection.query(input, values);
            if (input.sql.includes('DATE_FORMAT(UTC_TIMESTAMP(6)') && Array.isArray(rows)) {
                for (const row of rows as RowDataPacket[]) row.nowUtc = nowUtc;
            }
            return [rows, fields];
        } } as unknown as PoolConnection;
    let guardValue: ObservedRestoreGuard = { state: 'hold', database, serverUuid, epoch: randomUUID(),
        expiresAt: '2027-12-31T00:00:00.000Z', generation: '1' };
    let guardWrites = 0;
    const guard = { async read() { return guardValue; }, async commit(next: Omit<ObservedRestoreGuard, 'generation'>, expected: string) {
        assert.equal(expected, guardValue.generation); guardValue = { ...next, generation: '2' }; guardWrites++;
        throw new Error('synthetic guard acknowledgement lost'); } };
    let soft = false, metageneration = '1', custom: Record<string, string> = {};
    const metadata = () => ({ bucket: DELETION_JOURNAL_BUCKET, name: entry.name, generation: entry.generation, metageneration,
        size: String(Buffer.byteLength(body)), md5Hash: createHash('md5').update(body).digest('base64'), metadata: custom,
        ...(soft ? { softDeleteTime: future } : {}) });
    const client: JournalHttpClient = { async request(request) {
        if (request.url.endsWith(`/b/${DELETION_JOURNAL_BUCKET}`)) return { status: 200, data: { name: DELETION_JOURNAL_BUCKET,
            versioning: { enabled: true }, softDeletePolicy: { retentionDurationSeconds: '604800' } } };
        if (request.method === 'PATCH') { assert.equal(request.params.ifGenerationMatch, entry.generation);
            custom = JSON.parse(request.data!).metadata; metageneration = '2'; return { status: 200, data: metadata() }; }
        if (request.method === 'DELETE') { assert.equal(request.params.ifMetagenerationMatch, '2'); soft = true; return { status: 204, data: undefined }; }
        if (request.params.softDeleted) return { status: soft ? 200 : 404, data: soft ? metadata() : {} };
        if (soft) return { status: 404, data: {} };
        return { status: 200, data: request.params.alt === 'media' ? body : metadata() };
    } };
    const cloud: CloudSqlMetadataClient = { async listBackups() { return { kind: 'sql#backupRunsList', items: [{
        kind: 'sql#backupRun', id: '1', status: 'SUCCESSFUL', enqueuedTime: floor, startTime: floor, instance: 'cms-mickeyf' }] }; },
    async getRecoveryWindow() { return { kind: 'sql#getLatestRecoveryTime', earliestRecoveryTime: floor, latestRecoveryTime: future }; } };
    const journal = { async readDeletionEntries() { return { entries: [entry], digest: 'a'.repeat(64) }; } };
    const common = { connection: wrapped, pins, project: 'noted-reef-387021', instance: 'cms-mickeyf', cloud, journal,
        verifySchema: async () => {}, confirmation: 'ORIGINAL PRIMARY AND ALL WRITERS FENCED',
        externalCopiesConfirmation: 'ALL PERMITTED RECOVERY COPIES ACCOUNTED FOR' };
    const options = { ...common, lineage, publicKey: keys.publicKey, privateKey: keys.privateKey,
        selected: [{ name: entry.name, generation: entry.generation, contentSha256: entry.contentSha256 }] };
    const prepared = await prepareRecoverySafeRetirement(options, guard);
    assert.deepEqual(await finishRecoverySafeRetirement(options, guard, prepared), { status: 'waiting' });
    assert.equal(guardValue.generation, '1');
    floorMs = nowMs + 24 * 60 * 60_000; nowMs = floorMs + 24 * 60 * 60_000;
    floor = new Date(floorMs).toISOString(); future = new Date(nowMs).toISOString(); nowUtc = future.replace('Z', '000Z');
    await assert.rejects(finishRecoverySafeRetirement(options, guard, prepared));
    const advanced = await finishRecoverySafeRetirement(options, guard, prepared);
    assert.equal(advanced.status, 'advanced');
    if (advanced.status !== 'advanced') assert.fail('expected an advanced guard');
    assert.equal(guardWrites, 1);
    assert.equal(advanced.permit.claim.epoch, '1');
    const held = { async readRestoreGuard() { return guardValue; } };
    const activityKey = Buffer.alloc(32, 1), warningKey = Buffer.alloc(32, 2);
    function event(witnessKey: Buffer, generation: string): RetirementWitness {
        const tag = createHmac('sha256', witnessKey).update('ludolume-child-head-id-v1\0').update(account).digest('hex');
        return { name: `v1/events/${tag}/000000000001.json`, generation, metageneration: '1', contentSha256: 'a'.repeat(64) };
    }
    let events = [event(activityKey, '10'), event(warningKey, '11')];
    const witnesses = createCoveredWitnessRetirement({ activityKey, warningKey, async verifyPolicy() {},
        listKnownAccountIds: () => readRetirementKnownAccounts({ connection: wrapped, explicit: journal,
            conditional: { async readIntents() { return []; } } }),
        store: { async listAllIdentities() { return events.map(({ name, generation }) => ({ name, generation })); },
            async list(id, witnessKey) { assert.equal(id, account); return events.filter(value => value.name === event(witnessKey, '1').name); },
            async remove(value) { events = events.filter(item => item.name !== value.name || item.generation !== value.generation); },
            async assertEmpty(id, witnessKey) { assert.equal(id, account);
                assert.equal(events.filter(value => value.name === event(witnessKey, '1').name).length, 0); } } });
    await retireExplicitDeletionEntry({ ...common, guard: held, client, entry, permit: advanced.permit,
        publicKey: keys.publicKey, privateKey: keys.privateKey,
        retireWitnesses: witnesses.retireWitnesses, verifyWitnessesAbsent: witnesses.verifyWitnessesAbsent });
    witnesses.dispose(); assert.equal(events.length, 0);
    assert.equal(soft, true);
    await connection.query('UPDATE account_recovery_checkpoint SET epoch=0');
    await connection.query('INSERT INTO users (account_uuid) VALUES (?)', [account]);
    await assert.rejects(inspectExplicitRetirement({ connection: wrapped, pins, entry, permit: advanced.permit, publicKey: keys.publicKey, guard: held, client }));
    await connection.query('DELETE FROM users');
    await connection.query('UPDATE account_recovery_checkpoint SET epoch=1');
    assert.equal(await inspectExplicitRetirement({ connection: wrapped, pins, entry, permit: advanced.permit, publicKey: keys.publicKey, guard: held, client }), 'retired');
});
