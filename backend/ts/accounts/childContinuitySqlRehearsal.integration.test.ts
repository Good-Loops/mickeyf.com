import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { before, after } from 'node:test';
import mysql, { type Connection, type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import { loadMigrationManifest } from '../migrations/migrationManifest';
import { applyMigrations } from '../migrations/migrationRunner';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { ACTIVITY_DRAFT_SQL, assertActivityDraft, CONTINUITY_DRAFT_SQL, assertContinuityDraft, WARNING_DRAFT_SQL, assertWarningDraft } from './inactivitySchema.testFixture';
import { type ParentManagedChildActivity } from './parentManagedChildActivity';
import { keepManagedChild, recordOnlineInteraction } from './managedChildOnlineActivity';
import { createAccountSession } from '../auth/accountSessionRepository';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import { withUserSubmissionLock } from '../leaderboards/userSubmissionLock';
import { type AppendOnlyObjectTransport } from './childContinuityAppendOnly';
import { ContinuityHeadUnavailableError, type ContinuityHead, type ContinuityLedgerRow } from './childContinuityHead';

import { createDurableChildActivity } from './durableChildActivity';
import { verifyChildActivityContinuityReadiness } from '../migrations/childActivityContinuityReadiness';
import { renderRuntimeGrantStatements } from '../security/runtimeGrantManifest';
import { guardConnectionQueries } from '../db/queryTimeoutConnection';
import { submitP4VegaScore } from '../leaderboards/p4VegaScoreRepository';
import { submitThreeBossesRun } from '../leaderboards/threeBossesRunRepository';
import { createParentRegistrationRepository } from './parentRegistrationRepository';

const config = loadMigrationConfig();
const bucket = 'synthetic-continuity-sql';
const key = Buffer.alloc(32, 9);
const held = ContinuityHeadUnavailableError;
let admin: Connection;
let database: Pool;
let seedDatabase: Pool;
let serverUuid: string;
type Sql = Pick<PoolConnection, 'query'>;
type Witness = { head: ContinuityHead; ledgerRows: readonly ContinuityLedgerRow[] };

before(async () => {
    assert.equal(process.env.SYNTHETIC_PARENT_CONSENT_REHEARSAL, '1');
    assert.equal(process.env.NODE_ENV, 'test');
    assert.match(process.env.SYNTHETIC_REHEARSAL_CONTAINER ?? '', /^[a-f0-9]{64}$/u);
    assert.equal(config.host, '127.0.0.1'); assert.equal(config.database, 'mickeyf_migration_test');
    assert.equal(config.user, 'migration_test'); assert.equal(config.password, 'migration-test-only');
    assert.equal(config.port, Number(process.env.MIGRATION_TEST_PORT)); assert.notEqual(config.port, 3306);
    for (const name of ['DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS',
        'CLOUD_SQL_CONNECTION_NAME', 'GOOGLE_APPLICATION_CREDENTIALS']) assert.equal(process.env[name], undefined);
    const options = { host: config.host, port: config.port, database: config.database, user: 'root',
        password: 'migration-test-root-only', multipleStatements: false, dateStrings: true, timezone: 'Z' };
    admin = await mysql.createConnection(options);
    const [[target]] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db, @@version AS version, @@version_comment AS vendor, @@GLOBAL.server_uuid AS serverUuid');
    serverUuid = target.serverUuid;
    assert.equal(target.db, config.database); assert.match(target.version, /^8\.0\.31(?:-|$)/u); assert.doesNotMatch(target.vendor, /Google/iu);
    const [tables] = await admin.query<RowDataPacket[]>('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    assert.equal(tables.length, 0, 'fixture must be empty');
    await admin.query(`CREATE TABLE users (user_id INT NOT NULL AUTO_INCREMENT, user_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL, user_password VARCHAR(255) NOT NULL, PRIMARY KEY (user_id), UNIQUE KEY uq_users_email (email))
        ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const migrations = loadMigrationManifest();
    for (const allowedEffectKinds of [['create-table'] as const, ['drop-column'] as const,
        [...new Set(migrations.filter(migration => migration.version > '0003').map(migration => migration.effect))]]) {
        await applyMigrations(admin as unknown as MigrationConnection, migrations, config, { allowedEffectKinds });
    }
    assertActivityDraft(readFileSync(path.resolve(__dirname, '../../migrations/pending/draft_create_parent_managed_child_activity.sql'), 'utf8'));
    await admin.query(ACTIVITY_DRAFT_SQL);
    assertContinuityDraft(readFileSync(path.resolve(__dirname, '../../migrations/pending/draft_parent_child_activity_continuity.sql'), 'utf8'));
    await admin.query(CONTINUITY_DRAFT_SQL);
    assertWarningDraft(readFileSync(path.resolve(__dirname, '../../migrations/pending/draft_parent_child_inactivity_warnings.sql'), 'utf8'));
    await admin.query(WARNING_DRAFT_SQL);
    await admin.query("CREATE USER 'continuity_runtime_test'@'%' IDENTIFIED BY 'continuity-runtime-test-only'");
    for (const sql of renderRuntimeGrantStatements(config.database, { user: 'continuity_runtime_test', host: '%' },
        'google-apple-parent-signed-continuity')) await admin.query(sql);
    database = mysql.createPool({ ...options, connectionLimit: 5, user: 'continuity_runtime_test', password: 'continuity-runtime-test-only' });
    seedDatabase = mysql.createPool({ ...options, connectionLimit: 5 });
});
after(async () => { if (database) await database.end(); if (seedDatabase) await seedDatabase.end(); if (admin) await admin.end(); });

/** Fault injection is external to SQL: SQL rollback and restore cannot rewind it. */
function provider() {
    type ObjectRecord = { bucket: string; name: string; generation: string; size: string; md5Hash: string; body: string };
    const objects: ObjectRecord[] = [];
    let lostResponse = false, unavailable = false;
    let beforeCreate: (() => Promise<void>) | undefined;
    let afterCreate: (() => void) | undefined;
    const metadata = ({ body: _body, ...value }: ObjectRecord) => value;
    const transport: AppendOnlyObjectTransport = {
        async list(input) {
            if (unavailable) throw new Error('synthetic provider unavailable');
            const found = input.softDeleted ? [] : objects.filter(value => value.bucket === input.bucket
                && value.name.startsWith(input.prefix) && value.name >= input.startOffset)
                .sort((a, b) => a.name < b.name ? -1 : 1);
            return { kind: 'storage#objects', items: found.slice(0, input.maxResults).map(metadata),
                ...(found.length > input.maxResults ? { nextPageToken: 'more' } : {}) };
        },
        async readBody(input) {
            assert.equal(input.ifGenerationMatch, input.generation);
            const found = objects.find(value => value.bucket === input.bucket && value.name === input.name && value.generation === input.generation);
            if (!found || unavailable) throw new Error('synthetic object unavailable');
            return found.body;
        },
        async createOnly(input) {
            try {
                if (beforeCreate) await beforeCreate();
                assert.equal(input.ifGenerationMatch, '0');
                if (unavailable || objects.some(value => value.bucket === input.bucket && value.name === input.name)) throw new Error('synthetic create failed');
                const value = { bucket: input.bucket, name: input.name, generation: String(objects.length + 1),
                    size: String(Buffer.byteLength(input.body)), md5Hash: createHash('md5').update(input.body).digest('base64'), body: input.body };
                objects.push(value);
                if (lostResponse) throw new Error('synthetic response lost after durable create');
                return metadata(value);
            } finally { afterCreate?.(); }
        },
    };
    return { objects, transport,
        loseResponse() { lostResponse = true; }, unavailable() { unavailable = true; },
        onCreate(callback: () => Promise<void>) { beforeCreate = callback; },
        onCreateSettled(callback: () => void) { afterCreate = callback; } };
}

async function state(connection: Sql, childId: string): Promise<Buffer> {
    const [rows] = await connection.query<RowDataPacket[]>(`SELECT c.child_uuid, c.parent_uuid, c.country_code,
        HEX(c.policy_digest) AS policy_digest, c.consent_version,
        DATE_FORMAT(a.retention_activity_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS activity
        FROM parent_child_consents c JOIN parent_managed_child_activity a ON a.child_uuid=c.child_uuid
        WHERE c.child_uuid=? FOR SHARE`, [childId]);
    assert.equal(rows.length, 1);
    // Versioned fixture state covers these fields only, not warning/contact/deletion state.
    return Buffer.from(JSON.stringify({ version: 1, ...rows[0] }));
}
async function witness(connection: Sql, childId: string): Promise<Witness> {
    const [[row]] = await connection.query<RowDataPacket[]>('SELECT CAST(head_json AS CHAR) AS head_json, CAST(ledger_json AS CHAR) AS ledger_json FROM parent_child_activity_continuity WHERE child_uuid=? FOR UPDATE', [childId]);
    assert.ok(row);
    return { head: JSON.parse(row.head_json), ledgerRows: JSON.parse(row.ledger_json) };
}
async function save(connection: Sql, childId: string, value: Witness): Promise<void> {
    const [result] = await connection.query<ResultSetHeader>(`INSERT INTO parent_child_activity_continuity VALUES (?,?,?)
        ON DUPLICATE KEY UPDATE head_json=VALUES(head_json), ledger_json=VALUES(ledger_json)`,
    [childId, JSON.stringify(value.head), JSON.stringify(value.ledgerRows)]);
    assert.ok(result.affectedRows === 1 || result.affectedRows === 2);
}

async function fixture() {
    const storage = provider();
    const durable = createDurableChildActivity({ bucket, key, database: config.database, serverUuid }, storage.transport);
    const parentId = randomUUID(), childId = randomUUID();
    const addUser = async (connection: Sql, id: string) => {
        const userName = `synthetic-${id}`;
        const [result] = await connection.query<ResultSetHeader>('INSERT INTO users (user_name,email,user_password,account_uuid) VALUES (?,?,?,?)',
            [userName, `${id}@example.test`, 'not-a-real-password', id]);
        return { accountId: id, userId: result.insertId, userName };
    };
    const parent = await addUser(admin, parentId);
    const child = await withUserSubmissionLock(seedDatabase, parent.userId, async parentLock => {
        await parentLock.connection.beginTransaction();
        try {
            const created = await addUser(parentLock.connection, childId);
            await parentLock.withAdditionalLock(created.userId, async lock => {
                await lock.connection.query(`INSERT INTO parent_child_consents
                    (child_uuid,parent_uuid,country_code,policy_digest,consent_version,consented_at)
                    VALUES (?,?,'US',?,'synthetic',UTC_TIMESTAMP(6))`, [childId, parentId, Buffer.alloc(32, 4)]);
                await durable.initialize(lock.connection, childId);
                await durable.verifyActivity(lock.connection, childId);
                await lock.connection.commit();
            });
            return created;
        } catch (error) { await parentLock.connection.rollback(); throw error; }
    });
    async function context(account: typeof parent): Promise<ProviderAuthContext> {
        const sessionId = randomBytes(32).toString('base64url'), expiresAt = Math.floor(Date.now() / 1000) + 3600;
        assert.equal(await createAccountSession(database, account, sessionId, expiresAt), true);
        return { account, session: { accountId: account.accountId, sessionId } } as unknown as ProviderAuthContext;
    }
    const parentContext = await context(parent), childContext = await context(child);
    let afterWitness: (() => void) | undefined;
    // Only fault injection is test-specific; the real factory owns SQL and external writes.
    const activity: ParentManagedChildActivity = { initialize: durable.initialize,
        async recordInteraction(...args) {
            const result = await durable.recordInteraction(...args);
            afterWitness?.();
            return result;
        } };
    const verify = () => withUserSubmissionLock(database, child.userId, async lock => {
        await lock.connection.beginTransaction();
        try {
            await durable.verifyActivity(lock.connection, childId);
            return witness(lock.connection, childId);
        } finally { await lock.connection.rollback(); }
    });
    return { parent, child, childId, storage, durable, activity, parentContext, childContext, verify,
        afterWitness(callback: () => void) { afterWitness = callback; },
        keep: (db: Pick<Pool, 'getConnection'> = database) => keepManagedChild(db, parentContext, childId, activity),
        play: () => recordOnlineInteraction(database, childContext, activity) };
}

test('startup verifies the exact schema using restricted runtime grants and rejects a different primary', async () => {
    await verifyChildActivityContinuityReadiness(database, { database: config.database, serverUuid });
    await assert.rejects(verifyChildActivityContinuityReadiness(database, { database: config.database, serverUuid: randomUUID() }), /primary differs/);
    await assert.rejects(database.query('DELETE FROM parent_child_activity_continuity WHERE child_uuid=?', [randomUUID()]), /denied/);
    await assert.rejects(database.query('UPDATE parent_child_activity_continuity SET child_uuid=? WHERE child_uuid=?',
        [randomUUID(), randomUUID()]), /denied/);
});

test('startup refuses weakened constraints and missing runtime read grants', async () => {
    await admin.query('ALTER TABLE parent_child_activity_continuity ALTER CHECK chk_child_continuity_head NOT ENFORCED');
    try { await assert.rejects(verifyChildActivityContinuityReadiness(database, { database: config.database, serverUuid }), /constraints differ/); }
    finally { await admin.query('ALTER TABLE parent_child_activity_continuity ALTER CHECK chk_child_continuity_head ENFORCED'); }
    await admin.query("REVOKE SELECT ON mickeyf_migration_test.parent_child_activity_continuity FROM 'continuity_runtime_test'@'%'");
    try { await assert.rejects(verifyChildActivityContinuityReadiness(database, { database: config.database, serverUuid }), /schema or permissions differ/); }
    finally { await admin.query("GRANT SELECT ON mickeyf_migration_test.parent_child_activity_continuity TO 'continuity_runtime_test'@'%'"); }
    await verifyChildActivityContinuityReadiness(database, { database: config.database, serverUuid });
});

test('new child, authenticated activity and parent keep commit matching independent evidence', async () => {
    const f = await fixture();
    assert.equal((await f.verify()).head.sequence, 1);
    assert.equal(await f.play(), true); await f.keep();
    assert.equal((await f.verify()).head.sequence, 3);
    assert.equal(f.storage.objects.length, 3);
    for (const entry of f.storage.objects) {
        assert.ok(!entry.body.includes(f.parent.accountId) && !entry.body.includes(f.childId));
        assert.ok(!entry.body.includes('example.test'));
    }
});

test('actual password login and both score repositories commit independent activity evidence', async () => {
    const f = await fixture(), expires = Math.floor(Date.now() / 1000) + 3600;
    assert.equal(await createAccountSession(database, f.child, randomBytes(32).toString('base64url'), expires,
        'wrong-password-hash', false, undefined, f.activity), false);
    assert.equal((await f.verify()).head.sequence, 1);
    assert.equal(await createAccountSession(database, f.child, randomBytes(32).toString('base64url'), expires,
        'not-a-real-password', false, undefined, f.activity), true);
    assert.equal((await f.verify()).head.sequence, 2);
    await submitP4VegaScore(database, f.child.userId, 40, f.childContext.session!, f.activity);
    assert.equal((await f.verify()).head.sequence, 3);
    const runId = randomUUID();
    const run = await submitThreeBossesRun(database, f.child.userId, runId, 120_000, f.childContext.session!, f.activity);
    assert.equal(run.kind, 'accepted');
    assert.equal((await f.verify()).head.sequence, 4);
    // A duplicate score receipt is a replay, not a new activity assertion.
    await submitThreeBossesRun(database, f.child.userId, runId, 120_000, f.childContext.session!, f.activity);
    assert.equal((await f.verify()).head.sequence, 4);
});

test('a witness failure rolls password-session issuance and score persistence back together', async () => {
    const f = await fixture(), original = await f.verify();
    const [[before]] = await admin.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM account_sessions WHERE account_uuid=?', [f.childId]);
    f.storage.unavailable();
    await assert.rejects(createAccountSession(database, f.child, randomBytes(32).toString('base64url'),
        Math.floor(Date.now() / 1000) + 3600, 'not-a-real-password', false, undefined, f.activity));
    const [[after]] = await admin.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM account_sessions WHERE account_uuid=?', [f.childId]);
    assert.equal(after.n, before.n);
    await assert.rejects(submitP4VegaScore(database, f.child.userId, 40, f.childContext.session!, f.activity));
    await assert.rejects(submitThreeBossesRun(database, f.child.userId, randomUUID(), 120_000, f.childContext.session!, f.activity));
    const [[scores]] = await admin.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM game_personal_bests WHERE user_id=?', [f.child.userId]);
    const [[receipts]] = await admin.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM game_submission_receipts WHERE user_id=?', [f.child.userId]);
    assert.equal(scores.n, 0); assert.equal(receipts.n, 0);
    assert.deepEqual(await witness(admin, f.childId), original);
});

test('activity rejects missing transaction, missing account lock, wrong primary and clock drift before writes', async () => {
    const f = await fixture();
    const raw = await database.getConnection(), guarded = guardConnectionQueries(raw);
    try {
        await assert.rejects(f.durable.recordInteraction(guarded, f.childId), held);
        await guarded.beginTransaction();
        await assert.rejects(f.durable.recordInteraction(raw, f.childId), held);
        await assert.rejects(f.durable.recordInteraction(guarded, f.childId), held);
        await guarded.rollback();
    } finally { guarded.release(); }
    for (const factory of [
        createDurableChildActivity({ bucket, key, database: config.database, serverUuid: randomUUID() }, f.storage.transport),
        createDurableChildActivity({ bucket, key, database: 'wrong_database', serverUuid }, f.storage.transport),
        createDurableChildActivity({ bucket, key, database: config.database, serverUuid }, f.storage.transport, () => Date.now() + 60_000),
    ]) {
        await withUserSubmissionLock(database, f.child.userId, async lock => {
            await lock.connection.beginTransaction();
            try { await assert.rejects(factory.recordInteraction(lock.connection, f.childId), held); }
            finally { await lock.connection.rollback(); }
        });
    }
    assert.equal(f.storage.objects.length, 1); assert.equal((await f.verify()).head.sequence, 1);
});

test('ordinary adult and historically untracked child activity does not manufacture a deletion baseline', async () => {
    const f = await fixture();
    assert.equal(await recordOnlineInteraction(database, f.parentContext, f.activity), false);
    assert.equal(f.storage.objects.length, 1);
    // Privileged fixture deletion models an old account that never had tracking enabled.
    await admin.query('DELETE FROM parent_managed_child_activity WHERE child_uuid=?', [f.childId]);
    await f.play();
    const [[count]] = await admin.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM parent_managed_child_activity WHERE child_uuid=?', [f.childId]);
    assert.equal(count.n, 0); assert.equal(f.storage.objects.length, 1);
    await assert.rejects(f.verify(), held);
});

for (const unavailable of [false, true]) test(`actual child creation ${unavailable ? 'rolls approval back on unavailable history' : 'commits a genesis under its parent lock'}`, async () => {
    const f = await fixture(), grantHash = randomBytes(32), digest = Buffer.alloc(32, 4), reference = randomUUID();
    const context = { ...f.parentContext, bindingHash: randomBytes(32) };
    const userName = `synthetic-${randomUUID()}`, subject = Buffer.from(randomUUID());
    // Synthetic approved proof only: this does not exercise provider or owner consent acceptance.
    await admin.query(`INSERT INTO account_provider_identities (provider,subject,account_uuid,linked_at)
        VALUES ('google',?,?,UTC_TIMESTAMP(6))`, [subject, f.parent.accountId]);
    await admin.query(`INSERT INTO parent_registration_attempts
        (state_hash,binding_hash,parent_uuid,parent_user_id,client_key,nonce,policy_digest,purpose,country_code,
        expires_at,phase,grant_hash,provider,subject,consent_version,policy_version)
        VALUES (?,?,?,?,'google-web',?,?,'create-child','US',UTC_TIMESTAMP(6)+INTERVAL 10 MINUTE,'approved',?,'google',?,'synthetic','synthetic')`,
    [randomBytes(32), context.bindingHash, f.parent.accountId, f.parent.userId, randomBytes(32).toString('base64url'), digest, grantHash, subject]);
    await admin.query(`INSERT INTO parent_signed_forms
        (reference,parent_uuid,country_code,user_name,policy_digest,consent_version,policy_version,provider,subject,verified_contact,
        status,submitted_at,expires_at,reviewed_at,reviewer,form_sha256)
        VALUES (?,?,'US',?,?,'synthetic','synthetic','google',?,'synthetic@example.test','approved',UTC_TIMESTAMP(6),
        UTC_TIMESTAMP(6)+INTERVAL 1 DAY,UTC_TIMESTAMP(6),'SYNTHETIC ONLY',?)`,
    [reference, f.parent.accountId, userName, digest, subject, Buffer.alloc(32, 5)]);
    const repository = createParentRegistrationRepository(database, { async recordAccountDeletion() { throw new Error('Unexpected deletion'); } },
        undefined, true, { childActivity: f.durable });
    if (unavailable) f.storage.unavailable();
    const pending = repository.createChild(grantHash, context, digest, { userName, password: 'synthetic-child-password', formReference: reference });
    if (unavailable) {
        await assert.rejects(pending, held);
        const [users] = await admin.query<RowDataPacket[]>('SELECT user_id FROM users WHERE user_name=?', [userName]);
        assert.equal(users.length, 0);
        const [[form]] = await admin.query<RowDataPacket[]>('SELECT status FROM parent_signed_forms WHERE reference=?', [reference]);
        const [[grant]] = await admin.query<RowDataPacket[]>('SELECT phase FROM parent_registration_attempts WHERE grant_hash=?', [grantHash]);
        assert.equal(form.status, 'approved'); assert.equal(grant.phase, 'approved');
        assert.equal(f.storage.objects.length, 1);
    } else {
        const created = await pending;
        const [[child]] = await admin.query<RowDataPacket[]>('SELECT user_id FROM users WHERE account_uuid=?', [created.accountId]);
        await withUserSubmissionLock(database, child.user_id, async lock => {
            await lock.connection.beginTransaction();
            try { await f.durable.verifyActivity(lock.connection, created.accountId); }
            finally { await lock.connection.rollback(); }
        });
        assert.equal((await witness(admin, created.accountId)).head.sequence, 1);
        assert.equal(f.storage.objects.length, 2);
    }
});

test('a missing witness holds activity and startup instead of backfilling from SQL', async () => {
    const f = await fixture(), previous = await f.verify();
    await admin.query('DELETE FROM parent_child_activity_continuity WHERE child_uuid=?', [f.childId]);
    try {
        await assert.rejects(f.keep(), held);
        await assert.rejects(verifyChildActivityContinuityReadiness(database, { database: config.database, serverUuid }), /reconciliation/);
        assert.equal(f.storage.objects.length, 1);
    } finally { await save(admin, f.childId, previous); }
});

test('SQL rollback after a confirmed external event preserves a hold and refuses another keep', async () => {
    const f = await fixture(), original = await f.verify();
    f.afterWitness(() => { throw new Error('synthetic SQL failure before commit'); });
    await assert.rejects(f.keep(), /synthetic SQL failure/);
    assert.deepEqual(await witness(admin, f.childId), original);
    assert.equal(f.storage.objects.length, 2);
    await assert.rejects(f.verify(), held); await assert.rejects(f.keep(), held);
});

test('lost external write acknowledgment rolls SQL back but does not erase the event', async () => {
    const f = await fixture(), original = await witness(admin, f.childId);
    f.storage.loseResponse();
    await assert.rejects(f.play(), held);
    assert.deepEqual(await witness(admin, f.childId), original);
    assert.equal(f.storage.objects.length, 2);
    await assert.rejects(f.verify(), held);
});

test('after a lost SQL commit response a fresh authenticated keep conservatively resets the timer', async () => {
    const f = await fixture();
    let intercepted = false;
    const loseCommit = { async getConnection() {
        const connection = await database.getConnection();
        const original = connection.query.bind(connection);
        connection.query = (async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            const query = args[0] as unknown as { sql?: string };
            if (query.sql === 'COMMIT') { intercepted = true; throw new Error('synthetic lost SQL commit response'); }
            return result;
        }) as typeof connection.query;
        return connection;
    } };
    await assert.rejects(f.keep(loseCommit), /synthetic lost SQL commit response/); assert.equal(intercepted, true);
    const committed = await f.verify(), committedState = await state(admin, f.childId);
    assert.equal(committed.head.sequence, 2);
    await f.keep();
    assert.equal((await f.verify()).head.sequence, 3);
    assert.notDeepEqual(await state(admin, f.childId), committedState);
    assert.equal(f.storage.objects.length, 3);
});

test('restoring older SQL activity, witness and ledger cannot hide a later parent keep', async () => {
    const f = await fixture(), before = await f.verify(), old = JSON.parse((await state(admin, f.childId)).toString());
    await f.keep();
    await save(admin, f.childId, before);
    await admin.query('UPDATE parent_managed_child_activity SET retention_activity_at=? WHERE child_uuid=?',
        [old.activity.replace('T', ' ').replace('Z', ''), f.childId]);
    await assert.rejects(f.verify(), held); await assert.rejects(f.play(), held);
    assert.equal(f.storage.objects.length, 2);
});

test('a lost commit command before SQL executes leaves a durable hold after connection discard', async () => {
    const f = await fixture(), previous = await f.verify();
    const loseCommit = { async getConnection() {
        const connection = await database.getConnection(), original = connection.query.bind(connection);
        connection.query = (async (...args: Parameters<typeof original>) => {
            const query = args[0] as unknown as { sql?: string };
            if (query.sql === 'COMMIT') throw new Error('synthetic commit not sent');
            return original(...args);
        }) as typeof connection.query;
        return connection;
    } };
    await assert.rejects(f.keep(loseCommit), /synthetic commit not sent/);
    assert.deepEqual(await witness(admin, f.childId), previous);
    assert.equal(f.storage.objects.length, 2);
    await assert.rejects(f.verify(), held);
});

for (const delayedWins of [false, true]) test(`a late timed-out create cannot permit an unwitnessed SQL commit (${delayedWins ? 'old write' : 'new keep'} wins)`, async () => {
    const f = await fixture();
    let releaseOld!: () => void, oldEntered!: () => void, oldFinished!: () => void;
    let releaseNew!: () => void, newEntered!: () => void;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const oldStarted = new Promise<void>(resolve => { oldEntered = resolve; });
    const oldSettled = new Promise<void>(resolve => { oldFinished = resolve; });
    const newGate = new Promise<void>(resolve => { releaseNew = resolve; });
    const newStarted = new Promise<void>(resolve => { newEntered = resolve; });
    let creates = 0;
    f.storage.onCreate(async () => {
        if (++creates === 1) { oldEntered(); await oldGate; }
        else if (delayedWins) { newEntered(); await newGate; }
    });
    // The transport intentionally ignores cancellation to model a provider write
    // that can still complete after the client has timed out and SQL rolls back.
    const failed = assert.rejects(f.play(), held);
    await Promise.race([oldStarted, failed.then(() => { throw new Error('Activity failed before the delayed provider write'); })]);
    await failed;
    assert.equal(f.storage.objects.length, 1);
    // Observe actual late provider settlement without a timing-based sleep.
    // Both writes contend for the same deterministic name and create precondition.
    let settled = 0;
    f.storage.onCreateSettled(() => { if (++settled === (delayedWins ? 1 : 2)) oldFinished(); });
    try {
        if (delayedWins) {
            const next = assert.rejects(f.keep(), held);
            await Promise.race([newStarted, next.then(() => { throw new Error('Keep failed before the provider barrier'); })]);
            releaseOld(); await oldSettled; releaseNew(); await next;
            await assert.rejects(f.verify(), held);
            assert.equal((await witness(admin, f.childId)).head.sequence, 1);
        } else {
            await f.keep(); releaseOld(); await oldSettled;
            assert.equal((await f.verify()).head.sequence, 2);
        }
        assert.equal(f.storage.objects.length, 2);
    } finally { releaseOld(); releaseNew(); }
});

test('a partial SQL activity restore fails even with the latest witness and ledger', async () => {
    const f = await fixture(); await f.keep();
    await admin.query("UPDATE parent_managed_child_activity SET retention_activity_at='2020-01-01' WHERE child_uuid=?", [f.childId]);
    await assert.rejects(f.verify(), held);
});

test('a partial operation-ledger restore cannot authorize a retry', async () => {
    const f = await fixture(); await f.keep();
    const current = await witness(admin, f.childId);
    await save(admin, f.childId, { ...current, ledgerRows: current.ledgerRows.slice(0, 1) });
    await assert.rejects(f.keep(), held);
});

test('unavailable independent history leaves SQL unchanged', async () => {
    const f = await fixture(), old = await state(admin, f.childId), saved = await witness(admin, f.childId);
    f.storage.unavailable(); await assert.rejects(f.keep(), held);
    assert.deepEqual(await state(admin, f.childId), old); assert.deepEqual(await witness(admin, f.childId), saved);
});

test('invalid parent session cannot append a keep event', async () => {
    const f = await fixture();
    const invalid = { ...f.parentContext, session: { ...f.parentContext.session!, sessionId: randomBytes(32).toString('base64url') } };
    await assert.rejects(keepManagedChild(database, invalid, f.childId, f.activity), /Session unavailable/);
    assert.equal(f.storage.objects.length, 1); assert.equal((await f.verify()).head.sequence, 1);
});

test('concurrent child activity and parent keep serialize through SQL commit', async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const firstEntered = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    f.storage.onCreate(async () => { if (++calls === 1) { entered(); await gate; } });
    const play = f.play();
    await Promise.race([firstEntered, play.then(() => { throw new Error('Activity did not reach the witness barrier'); })]);
    // The second authenticated caller must acquire the same existing named child lock.
    let attempted!: () => void;
    const childLockAttempted = new Promise<void>(resolve => { attempted = resolve; });
    const observedPool = { async getConnection() {
        const connection = await database.getConnection();
        const originalQuery = connection.query, originalRelease = connection.release;
        connection.query = (async (...args: Parameters<typeof originalQuery>) => {
            const query = args[0] as unknown as { sql?: string }, values = args[1] as unknown as unknown[];
            if (query.sql?.includes('SELECT GET_LOCK(') && values?.[0] === f.child.userId) attempted();
            return originalQuery.apply(connection, args);
        }) as typeof connection.query;
        connection.release = () => { connection.query = originalQuery; connection.release = originalRelease; originalRelease.call(connection); };
        return connection;
    } };
    const keep = f.keep(observedPool);
    try {
        await Promise.race([childLockAttempted, keep.then(() => { throw new Error('Keep bypassed the child lock'); })]);
        assert.equal(f.storage.objects.length, 1); assert.equal(calls, 1);
    } finally { release(); }
    assert.deepEqual(await Promise.all([play, keep]), [true, undefined]);
    assert.equal((await f.verify()).head.sequence, 3); assert.equal(f.storage.objects.length, 3);
});
