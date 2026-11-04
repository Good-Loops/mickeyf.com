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
import { ACTIVITY_DRAFT_SQL, assertActivityDraft } from './inactivitySchema.testFixture';
import { parentManagedChildActivity, type ParentManagedChildActivity } from './parentManagedChildActivity';
import { keepManagedChild, recordOnlineInteraction } from './managedChildOnlineActivity';
import { createAccountSession } from '../auth/accountSessionRepository';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import { withUserSubmissionLock } from '../leaderboards/userSubmissionLock';
import { openAppendOnlyContinuitySession, type AppendOnlyObjectTransport } from './childContinuityAppendOnly';
import { ContinuityHeadUnavailableError, type ContinuityHead, type ContinuityLedgerRow,
    type ContinuityOperation } from './childContinuityHead';

const config = loadMigrationConfig();
const bucket = 'synthetic-continuity-sql';
const key = Buffer.alloc(32, 9);
const held = ContinuityHeadUnavailableError;
let admin: Connection;
let database: Pool;
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
    const [[target]] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db, @@version AS version, @@version_comment AS vendor');
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
    // Rehearsal-only table. This is deliberately NOT a release migration.
    await admin.query(`CREATE TABLE synthetic_continuity (child_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
        head_json TEXT NOT NULL, ledger_json MEDIUMTEXT NOT NULL,
        FOREIGN KEY (child_uuid) REFERENCES parent_child_consents(child_uuid) ON DELETE CASCADE) ENGINE=InnoDB`);
    database = mysql.createPool({ ...options, connectionLimit: 5 });
});
after(async () => { if (database) await database.end(); if (admin) await admin.end(); });

/** Fault injection is external to SQL: SQL rollback and restore cannot rewind it. */
function provider() {
    type ObjectRecord = { bucket: string; name: string; generation: string; size: string; md5Hash: string; body: string };
    const objects: ObjectRecord[] = [];
    let lostResponse = false, unavailable = false, timeoutMs = 10_000;
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
    return { objects,
        open: (head?: ContinuityHead) => openAppendOnlyContinuitySession({ transport, bucket, expectedBucket: bucket, key,
            sequence: head?.sequence ?? 0, generation: head?.generation ?? '0', timeoutMs }),
        loseResponse() { lostResponse = true; }, unavailable() { unavailable = true; },
        timeout(value: number) { timeoutMs = value; },
        onCreate(callback: () => Promise<void>) { beforeCreate = callback; },
        onCreateSettled(callback: () => void) { afterCreate = callback; } };
}

async function clock(connection: Sql): Promise<number> {
    const [[row]] = await connection.query<RowDataPacket[]>("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowValue");
    return Date.parse(row.nowValue);
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
    const [[row]] = await connection.query<RowDataPacket[]>('SELECT head_json, ledger_json FROM synthetic_continuity WHERE child_uuid=? FOR UPDATE', [childId]);
    assert.ok(row);
    return { head: JSON.parse(row.head_json), ledgerRows: JSON.parse(row.ledger_json) };
}
async function save(connection: Sql, childId: string, value: Witness): Promise<void> {
    const [result] = await connection.query<ResultSetHeader>(`INSERT INTO synthetic_continuity VALUES (?,?,?)
        ON DUPLICATE KEY UPDATE head_json=VALUES(head_json), ledger_json=VALUES(ledger_json)`,
    [childId, JSON.stringify(value.head), JSON.stringify(value.ledgerRows)]);
    assert.ok(result.affectedRows === 1 || result.affectedRows === 2);
}

async function fixture() {
    const storage = provider();
    const parentId = randomUUID(), childId = randomUUID();
    const addUser = async (connection: Sql, id: string) => {
        const userName = `synthetic-${id}`;
        const [result] = await connection.query<ResultSetHeader>('INSERT INTO users (user_name,email,user_password,account_uuid) VALUES (?,?,?,?)',
            [userName, `${id}@example.test`, 'not-a-real-password', id]);
        return { accountId: id, userId: result.insertId, userName };
    };
    const parent = await addUser(admin, parentId);
    const child = await withUserSubmissionLock(database, parent.userId, async parentLock => {
        await parentLock.connection.beginTransaction();
        try {
            const created = await addUser(parentLock.connection, childId);
            await parentLock.withAdditionalLock(created.userId, async lock => {
                await lock.connection.query(`INSERT INTO parent_child_consents
                    (child_uuid,parent_uuid,country_code,policy_digest,consent_version,consented_at)
                    VALUES (?,?,'US',?,'synthetic',UTC_TIMESTAMP(6))`, [childId, parentId, Buffer.alloc(32, 4)]);
                await parentManagedChildActivity.initialize(lock.connection, childId);
                const session = storage.open(), now = await clock(lock.connection), request = Buffer.from('synthetic-create');
                const initial = await session.initializeNew(childId, session.issueOperation(childId, request, now), now,
                    request, await state(lock.connection, childId));
                await save(lock.connection, childId, initial);
                const persisted = await witness(lock.connection, childId);
                await session.verifyExisting(childId, persisted.head, persisted.ledgerRows,
                    await state(lock.connection, childId), await clock(lock.connection));
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
    const request = Buffer.from('synthetic-activity');
    let retryOperation: ContinuityOperation | undefined;
    let afterWitness: (() => void) | undefined;
    // Test-only composition: real activity/keep callers retain their real locks and transactions.
    const activity: ParentManagedChildActivity = { initialize: parentManagedChildActivity.initialize,
        async recordInteraction(connection, accountId) {
            assert.equal(accountId, childId);
            const previous = await witness(connection, childId), currentState = await state(connection, childId);
            const session = storage.open(previous.head), now = await clock(connection);
            await session.verifyExisting(childId, previous.head, previous.ledgerRows, currentState, now);
            const operation = retryOperation ?? session.issueOperation(childId, request, now);
            retryOperation = operation;
            if (previous.ledgerRows.some(row => row.id === operation.id)) {
                const retried = await session.prepareExisting(childId, previous.head, operation, previous.ledgerRows,
                    now, request, currentState, currentState);
                assert.equal(retried.status, 'already-committed');
                return true;
            }
            // SQL work is tentative. Neither caller can commit before the external witness is verified.
            assert.equal(await parentManagedChildActivity.recordInteraction(connection, accountId), true);
            const nextState = await state(connection, childId);
            const next = await session.prepareExisting(childId, previous.head, operation, previous.ledgerRows,
                now, request, currentState, nextState);
            assert.equal(next.status, 'prepared');
            if (next.status !== 'prepared') throw new Error('Unexpected replay after SQL mutation');
            await save(connection, childId, next);
            const actual = await witness(connection, childId);
            await session.verifyExisting(childId, actual.head, actual.ledgerRows, await state(connection, childId), await clock(connection));
            afterWitness?.();
            return true;
        } };
    const verify = () => withUserSubmissionLock(database, child.userId, async lock => {
        await lock.connection.beginTransaction();
        try {
            const value = await witness(lock.connection, childId);
            await storage.open(value.head).verifyExisting(childId, value.head, value.ledgerRows,
                await state(lock.connection, childId), await clock(lock.connection));
            return value;
        } finally { await lock.connection.rollback(); }
    });
    return { parent, child, childId, storage, activity, parentContext, childContext, verify,
        nextOperation() { retryOperation = undefined; }, afterWitness(callback: () => void) { afterWitness = callback; },
        keep: (db: Pick<Pool, 'getConnection'> = database) => keepManagedChild(db, parentContext, childId, activity),
        play: () => recordOnlineInteraction(database, childContext, activity) };
}

test('new child, authenticated activity and parent keep commit matching independent evidence', async () => {
    const f = await fixture();
    assert.equal((await f.verify()).head.sequence, 1);
    assert.equal(await f.play(), true); f.nextOperation(); await f.keep();
    assert.equal((await f.verify()).head.sequence, 3);
    assert.equal(f.storage.objects.length, 3);
    for (const entry of f.storage.objects) {
        assert.ok(!entry.body.includes(f.parent.accountId) && !entry.body.includes(f.childId));
        assert.ok(!entry.body.includes('example.test'));
    }
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

test('a lost SQL commit response is resolved only by the same operation and fresh evidence', async () => {
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
    assert.deepEqual(await f.verify(), committed);
    assert.deepEqual(await state(admin, f.childId), committedState);
    assert.equal(f.storage.objects.length, 2);
});

test('restoring older SQL activity, witness and ledger cannot hide a later parent keep', async () => {
    const f = await fixture(), before = await f.verify(), old = JSON.parse((await state(admin, f.childId)).toString());
    await f.keep();
    await save(admin, f.childId, before);
    await admin.query('UPDATE parent_managed_child_activity SET retention_activity_at=? WHERE child_uuid=?',
        [old.activity.replace('T', ' ').replace('Z', ''), f.childId]);
    await assert.rejects(f.verify(), held); f.nextOperation(); await assert.rejects(f.play(), held);
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
    f.storage.timeout(250);
    const failed = assert.rejects(f.play(), held);
    await oldStarted; await failed;
    assert.equal(f.storage.objects.length, 1);
    f.storage.timeout(10_000); f.nextOperation();
    // Observe actual late provider settlement without a timing-based sleep.
    // Both writes contend for the same deterministic name and create precondition.
    let settled = 0;
    f.storage.onCreateSettled(() => { if (++settled === (delayedWins ? 1 : 2)) oldFinished(); });
    try {
        if (delayedWins) {
            const next = assert.rejects(f.keep(), held);
            await newStarted; releaseOld(); await oldSettled; releaseNew(); await next;
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
    // Give it its own operation only after the first caller has captured its token.
    f.nextOperation();
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
