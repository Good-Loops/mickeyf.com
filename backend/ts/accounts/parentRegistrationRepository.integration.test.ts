import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import mysql, { type Connection, type Pool, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import { loadMigrationManifest } from '../migrations/migrationManifest';
import { applyMigrations, planMigrations } from '../migrations/migrationRunner';
import { verifyParentRegistrationReadiness, verifyParentRegistrationTable } from '../migrations/parentRegistrationSchema';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import type { VerifiedProviderIdentity } from '../auth/providerIdentity';
import { createAccountSession, readLiveSession, revokeAccountSession, renewAccountSession } from '../auth/accountSessionRepository';
import { createProviderAuthContextReader } from '../auth/providerAuthContext';
import { deriveRenewedSessionId, issueSessionToken, issueRenewedSessionToken } from '../security/sessionPolicy';
import { createParentRegistrationFlow, type ParentRegistrationPolicy } from './parentRegistrationFlow';
import { createParentRegistrationRepository, assertNoManagedChildren, ManagedChildrenError, cleanupParentRegistrationAttempts } from './parentRegistrationRepository';
import { deleteAccount } from './accountDeletionRepository';
import { findPasswordLoginAccount } from './passwordAccountRepository';
import { renderRuntimeGrantStatements } from '../security/runtimeGrantManifest';
import { readP4VegaLeaderboard, submitP4VegaScore } from '../leaderboards/p4VegaScoreRepository';
import { withUserSubmissionLock } from '../leaderboards/userSubmissionLock';
import { applyDeletionReplay, planDeletionReplay } from './deletionReplay';
import type { DeletionReplaySettings } from '../config/deletionReplayConfig';

const config = loadMigrationConfig();
let admin: Connection; let database: Pool; let passwordHash: string;
const password = 'synthetic-parent-password';
const policy: ParentRegistrationPolicy = { version: 'test-parent-v1', consentVersion: 'test-consent-v1', consentText: 'Synthetic reviewed test consent.', countries: ['ZZ'] };
const input = { purpose: 'create-child', clientKey: 'google-web', policyVersion: policy.version, consentVersion: policy.consentVersion,
    country: 'ZZ', adultAttestation: true, guardianAttestation: true, consent: true };
const intents: string[] = [];
const journal = { async recordAccountDeletion(id: string) { intents.push(id); } };
before(async () => {
    assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.MIGRATION_TEST_ENABLED, '1');
    assert.equal(config.host, '127.0.0.1'); assert.equal(config.database, 'mickeyf_migration_test');
    assert.equal(config.user, 'migration_test'); assert.equal(config.password, 'migration-test-only');
    assert.equal(config.port, Number(process.env.MIGRATION_TEST_PORT)); assert.ok(config.port && config.port !== 3306);
    for (const key of ['DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CLOUD_SQL_CONNECTION_NAME']) assert.equal(process.env[key], undefined);
    assert.equal(process.env.MIGRATION_TEST_ROOT_PASSWORD, 'migration-test-root-only');
    admin = await mysql.createConnection({ host: config.host, port: config.port, database: config.database,
        user: 'root', password: 'migration-test-root-only', multipleStatements: false, dateStrings: true, timezone: 'Z' });
    const [target] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db, @@version AS version, @@version_comment AS vendor');
    assert.equal(target[0].db, config.database); assert.match(target[0].version, /^8\.0\.31(?:-|$)/u); assert.doesNotMatch(target[0].vendor, /Google/iu);
    await admin.query('SET FOREIGN_KEY_CHECKS = 0');
    try { await admin.query(`DROP TABLE IF EXISTS parent_child_consents, parent_registration_attempts, account_registration_profiles, registration_authorizations,
        apple_auth_revocations, apple_provider_tokens, account_sessions, provider_auth_attempts, account_provider_identities,
        game_personal_bests, game_runs, game_submission_receipts, schema_migrations, users`); }
    finally { await admin.query('SET FOREIGN_KEY_CHECKS = 1'); }
    await admin.query(`CREATE TABLE users (user_id INT NOT NULL AUTO_INCREMENT, user_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL, user_password VARCHAR(255) NOT NULL, PRIMARY KEY (user_id), UNIQUE KEY uq_users_email (email))
        ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const migrations = loadMigrationManifest();
    for (const allowedEffectKinds of [['create-table'] as const, ['drop-column'] as const,
        [...new Set(migrations.filter(m => m.version > '0003').map(m => m.effect))]]) {
        await applyMigrations(admin as unknown as MigrationConnection, migrations, config, { allowedEffectKinds });
    }
    await verifyParentRegistrationReadiness(admin as unknown as MigrationConnection);
    await admin.query("CREATE USER 'parent_runtime_test'@'%' IDENTIFIED BY 'parent-runtime-test-only'");
    for (const sql of renderRuntimeGrantStatements(config.database, { user: 'parent_runtime_test', host: '%' }, 'google-apple-parent')) await admin.query(sql);
    database = mysql.createPool({ host: config.host, port: config.port, database: config.database, user: 'parent_runtime_test',
        password: 'parent-runtime-test-only', multipleStatements: false, connectionLimit: 10, dateStrings: true, timezone: 'Z' });
    passwordHash = await bcrypt.hash(password, 4);
});
after(async () => { if (database) await database.end(); if (admin) await admin.end(); });

async function parent(accountId = randomUUID()) {
    const name = `parent-${randomUUID()}`;
    const [insert] = await admin.query<ResultSetHeader>('INSERT INTO users (user_name, email, user_password, account_uuid) VALUES (?, ?, ?, ?)', [name, `${name}@example.test`, passwordHash, accountId]);
    const [accounts] = await admin.query<RowDataPacket[]>('SELECT account_uuid FROM users WHERE user_id = ?', [insert.insertId]);
    const account = { userId: insert.insertId, accountId: String(accounts[0].account_uuid) };
    const sessionId = randomBytes(32).toString('base64url');
    assert.equal(await createAccountSession(database, account, sessionId, Math.floor(Date.now() / 1000) + 300, passwordHash), true);
    const identity = { provider: 'google', subject: name, email: `${name}@example.test` } as VerifiedProviderIdentity;
    await admin.query("INSERT INTO account_provider_identities (provider, subject, account_uuid, linked_at) VALUES ('google', ?, ?, UTC_TIMESTAMP(6))", [Buffer.from(name), account.accountId]);
    const context = { account, session: { accountId: account.accountId, sessionId }, bindingHash: randomBytes(32), bindingExpiresAt: null, anonymousCookie: null } as ProviderAuthContext;
    const store = createParentRegistrationRepository(database, journal);
    const clients = { 'google-web': { provider: 'google' as const, verifier: { async verify() { return { verified: true as const, identity }; } } } };
    const flow = createParentRegistrationFlow({ store, clients, policy });
    return { account, identity, context, flow, store, clients };
}
async function approve(p: Awaited<ReturnType<typeof parent>>, request: unknown = input) {
    const challenge = await p.flow.begin(p.context, request); assert.ok('state' in challenge, JSON.stringify(challenge));
    const proof = await p.flow.complete(p.context, { state: challenge.state, idToken: 'synthetic-verified-by-fixture' });
    assert.ok('grant' in proof, JSON.stringify(proof)); return { challenge, proof };
}
async function child(p: Awaited<ReturnType<typeof parent>>, name = `child-${randomUUID()}`) {
    const a = await approve(p); const result = await p.flow.createChild(p.context, { grant: a.proof.grant, userName: name, password });
    assert.ok('created' in result, JSON.stringify(result)); return { ...a, child: result.child };
}
const withdrawal = (id: string) => ({ purpose: 'withdraw-child', childAccountId: id, clientKey: 'google-web', policyVersion: policy.version, confirmation: 'WITHDRAW AND DELETE' });

test('rotating a remembered session rejects old proof/grants and fresh parent approval recovers', async () => {
    for (const phase of ['provider-proof', 'child-credentials']) {
        const p = await parent(); const secret = 'synthetic-renewal-parent-test'; const origin = 'https://parent.example.test';
        const identity = { ...p.account, userName: p.identity.subject };
        const initial = issueSessionToken(identity, secret, true);
        assert.equal(await createAccountSession(database, p.account, initial.sessionId, initial.expiresAt, passwordHash, true), true);
        const reader = createProviderAuthContextReader({ database, sessionSecret: secret, allowedOrigins: [origin] });
        const context = async (token: string) => {
            const result = await reader({ method: 'POST', headers: { origin, 'content-type': 'application/json' }, signedCookies: { __session: token }, cookies: {} });
            assert.ok(result); return result;
        };
        const before = await context(initial.token);
        const challenge = await p.flow.begin(before, input); assert.ok('state' in challenge);
        const approval = phase === 'child-credentials' ? await p.flow.complete(before, { state: challenge.state, idToken: 'synthetic-proof' }) : null;
        await admin.query('UPDATE account_sessions SET renewed_at=UTC_TIMESTAMP(6)-INTERVAL 16 MINUTE WHERE account_uuid=? AND remembered=1', [p.account.accountId]);
        const renewed = await renewAccountSession(database, p.account.userId, p.account.accountId, initial.sessionId, id => deriveRenewedSessionId(id, secret));
        assert.ok(renewed?.renewal);
        const after = await context(issueRenewedSessionToken(identity, secret, renewed.renewal));
        assert.ok(!before.bindingHash.equals(after.bindingHash));
        if (phase === 'provider-proof') assert.ok('error' in await p.flow.complete(after, { state: challenge.state, idToken: 'synthetic-proof' }));
        else { assert.ok(approval && 'grant' in approval);
            assert.ok('error' in await p.flow.createChild(after, { grant: approval.grant, userName: `stale-${randomUUID()}`, password })); }
        assert.deepEqual(await p.store.listChildren(after), []);
        const fresh = await p.flow.begin(after, input); assert.ok('state' in fresh);
        const proof = await p.flow.complete(after, { state: fresh.state, idToken: 'synthetic-proof' }); assert.ok('grant' in proof);
        assert.ok('created' in await p.flow.createChild(after, { grant: proof.grant, userName: `fresh-${randomUUID()}`, password }));
    }
});

test('ten simultaneous withdrawals complete when all ten pool connections hold their parent lock', async () => {
    const cases = [];
    for (let i = 0; i < 10; i++) {
        const p = await parent(); const c = await child(p); const a = await approve(p, withdrawal(c.child.accountId));
        cases.push({ p, c, a });
    }
    let acquisitions = 0, targets = 0; let releaseTargets!: () => void;
    const allTargets = new Promise<void>(resolve => { releaseTargets = resolve; });
    const bounded = { query: database.query.bind(database), async getConnection() {
        acquisitions++;
        // Bound the test's wait, including an implementation that queues for a second connection.
        const connection = await new Promise<Awaited<ReturnType<Pool['getConnection']>>>((resolve, reject) => {
            let expired = false;
            const timer = setTimeout(() => { expired = true; reject(new Error('pool acquisition budget exhausted')); }, 2000);
            void database.getConnection().then(value => { clearTimeout(timer); if (expired) value.release(); else resolve(value); }, error => { clearTimeout(timer); reject(error); });
        });
        return new Proxy(connection, { get(target, key) {
            const value = Reflect.get(target, key);
            if (key === 'query') return async (...args: unknown[]) => {
                const result = await Reflect.apply(value, target, args);
                if (typeof args[0] === 'object' && args[0] && 'sql' in args[0]
                    && String(args[0].sql).includes('SELECT u.user_id, u.account_uuid FROM parent_registration_attempts')) {
                    if (++targets === 10) releaseTargets();
                    await allTargets;
                }
                return result;
            };
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    } } as Pick<Pool, 'query' | 'getConnection'>;
    const results = await Promise.all(cases.map(({ p, a }) => createParentRegistrationFlow({
        store: createParentRegistrationRepository(bounded, journal), clients: p.clients, policy,
    }).withdrawChild(p.context, { grant: a.proof.grant, confirmation: 'WITHDRAW AND DELETE' })));
    assert.equal(targets, 10); assert.equal(acquisitions, 10);
    assert.ok(results.every(result => 'deleted' in result), JSON.stringify(results));
    for (const { p, c } of cases) {
        assert.deepEqual(await p.store.listChildren(p.context), []);
        assert.ok(intents.includes(c.child.accountId));
    }
    assert.equal((await database.query<RowDataPacket[]>('SELECT 1 AS available'))[0][0].available, 1);
});

test('restored parent and child journal intents replay child first even when the parent UUID sorts first', async () => {
    const p = await parent('00000000-0000-4000-8000-000000000001'); const c = await child(p);
    assert.ok(p.account.accountId.localeCompare(c.child.accountId) < 0);
    const savedUsers = (await admin.query<RowDataPacket[]>('SELECT * FROM users WHERE account_uuid IN (?, ?)', [p.account.accountId, c.child.accountId]))[0];
    const consent = (await admin.query<RowDataPacket[]>('SELECT * FROM parent_child_consents WHERE child_uuid=?', [c.child.accountId]))[0][0];
    const a = await approve(p, withdrawal(c.child.accountId));
    assert.deepEqual(await p.flow.withdrawChild(p.context, { grant: a.proof.grant, confirmation: 'WITHDRAW AND DELETE' }), { deleted: true });
    assert.equal(await deleteAccount(database, p.account.userId, password, journal, p.context.session!, assertNoManagedChildren), 'deleted');
    assert.ok(intents.includes(c.child.accountId) && intents.includes(p.account.accountId));
    for (const row of savedUsers) await admin.query('INSERT INTO users SET ?', [row]);
    await admin.query('INSERT INTO parent_child_consents SET ?', [consent]);
    const replayPool = mysql.createPool({ host: config.host, port: config.port, database: config.database, user: 'root',
        password: 'migration-test-root-only', connectionLimit: 1, multipleStatements: false, dateStrings: true, timezone: 'Z' });
    try {
        const [identity] = await admin.query<RowDataPacket[]>('SELECT CURRENT_USER() AS currentUser, @@GLOBAL.server_uuid AS serverUuid');
        const [epochs] = await admin.query<RowDataPacket[]>("SELECT DATE_FORMAT(applied_at, '%Y-%m-%d %H:%i:%s.%f') AS epoch FROM schema_migrations WHERE version='0008_finalize_account_identity'");
        const settings: DeletionReplaySettings = { mode: 'recovery', database: config.database,
            expectedCurrentUser: identity[0].currentUser, expectedServerUuid: identity[0].serverUuid,
            expectedIdentityEpoch: epochs[0].epoch, sourceServerUuid: '11111111-2222-4333-8444-555555555555', maxIntents: 10, maxDurationMs: 60000 };
        const entry = (accountId: string) => ({ version: 1 as const, action: 'delete-account' as const, accountId, requestedAt: '2026-09-30T00:00:00.000Z' });
        const parentOnly = { async readDeletionIntents() { return { digest: 'a'.repeat(64), intents: [entry(p.account.accountId)] }; } };
        const blocked = await planDeletionReplay(replayPool, parentOnly, settings);
        await assert.rejects(applyDeletionReplay(replayPool, parentOnly, settings, blocked.sha256));
        assert.equal((await admin.query<RowDataPacket[]>('SELECT account_uuid FROM users WHERE account_uuid IN (?, ?)', [p.account.accountId, c.child.accountId]))[0].length, 2);
        const complete = { async readDeletionIntents() { return { digest: 'b'.repeat(64), intents: [entry(p.account.accountId), entry(c.child.accountId)] }; } };
        const approved = await planDeletionReplay(replayPool, complete, settings);
        const result = await applyDeletionReplay(replayPool, complete, settings, approved.sha256);
        assert.equal(result.deletedAccounts, 2);
        assert.equal((await admin.query<RowDataPacket[]>('SELECT account_uuid FROM users WHERE account_uuid IN (?, ?)', [p.account.accountId, c.child.accountId]))[0].length, 0);
        assert.equal((await applyDeletionReplay(replayPool, complete, settings, approved.sha256)).absentAccounts, 2);
    } finally { await replayPool.end(); }
});

test('all 23 migrations, exact runtime grants and private child creation work without child email or parent session replacement', async () => {
    const plan = await planMigrations(admin as unknown as MigrationConnection, loadMigrationManifest(), config);
    assert.equal(plan.applied.length, 23); assert.deepEqual(plan.pending, []);
    const p = await parent(); const c = await child(p);
    const [rows] = await admin.query<RowDataPacket[]>(`SELECT u.email, p.age_band, p.score_visibility, c.parent_uuid, c.consent_version
        FROM users u JOIN account_registration_profiles p ON p.account_uuid=u.account_uuid JOIN parent_child_consents c ON c.child_uuid=u.account_uuid
        WHERE u.account_uuid=?`, [c.child.accountId]);
    assert.equal(rows[0].email, null); assert.equal(rows[0].age_band, 'minor'); assert.equal(rows[0].score_visibility, 'private');
    assert.equal(rows[0].parent_uuid, p.account.accountId); assert.equal(rows[0].consent_version, policy.consentVersion);
    const login = await findPasswordLoginAccount(database, c.child.userName);
    assert.equal(login?.accountId, c.child.accountId);
    assert.ok(login?.passwordHash && await bcrypt.compare(password, login.passwordHash));
    assert.ok(await readLiveSession(database, p.account.userId, p.account.accountId, p.context.session!.sessionId));
    const listed = await p.store.listChildren(p.context); assert.equal(listed.length, 1); assert.equal(listed[0].accountId, c.child.accountId);
});

test('schema readiness rejects purpose grouping, disabled checks and parent cascade drift', async () => {
    for (const drift of ['grouping', 'disabled', 'cascade']) {
        const connection = { query: async (sql: string, values: unknown[]) => {
            const [rows, fields] = await admin.query<RowDataPacket[]>(sql, values);
            const changed = rows.map(row => {
                if (drift === 'grouping' && row.name === 'chk_parent_attempt_purpose') return { ...row, clause: String(row.clause).replace(/[()]/gu, '') };
                if (drift === 'disabled' && row.name === 'chk_parent_attempt_purpose') return { ...row, enforced: 'NO' };
                if (drift === 'cascade' && row.name === 'fk_child_consent_parent') return { ...row, deletion: 'CASCADE' };
                return row;
            });
            return [changed, fields];
        } } as unknown as MigrationConnection;
        await assert.rejects(verifyParentRegistrationTable(connection, drift === 'cascade' ? 'parent_child_consents' : 'parent_registration_attempts'), /reviewed definition/u);
    }
});
test('concurrent reuse of a real SQL grant creates exactly one complete child', async () => {
    const p = await parent(); const a = await approve(p);
    const results = await Promise.all([1, 2].map(n => p.flow.createChild(p.context, { grant: a.proof.grant, userName: `race-${n}-${randomUUID()}`, password })));
    assert.equal(results.filter(result => 'created' in result).length, 1);
    assert.equal((await p.store.listChildren(p.context)).length, 1);
});
test('duplicate username rolls back insertion and leaves the grant usable for another name', async () => {
    const p = await parent(); const first = await child(p); const a = await approve(p);
    assert.ok('error' in await p.flow.createChild(p.context, { grant: a.proof.grant, userName: first.child.userName, password }));
    assert.ok('created' in await p.flow.createChild(p.context, { grant: a.proof.grant, userName: `retry-${randomUUID()}`, password }));
    assert.equal((await p.store.listChildren(p.context)).length, 2);
});

test('consent failure rolls back the child and private profile together and leaves the grant usable', async () => {
    const p = await parent(); const a = await approve(p); const name = `rollback-${randomUUID()}`;
    await admin.query("CREATE TRIGGER synthetic_consent_outage BEFORE INSERT ON parent_child_consents FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic consent outage'");
    try {
        assert.ok('error' in await p.flow.createChild(p.context, { grant: a.proof.grant, userName: name, password }));
        assert.equal((await admin.query<RowDataPacket[]>('SELECT user_id FROM users WHERE user_name=?', [name]))[0].length, 0);
        assert.deepEqual(await p.store.listChildren(p.context), []);
    } finally { await admin.query('DROP TRIGGER synthetic_consent_outage'); }
    assert.ok('created' in await p.flow.createChild(p.context, { grant: a.proof.grant, userName: name, password }));
});

test('parent deletion winning the account lock prevents a waiting child creation without an orphan', async () => {
    const p = await parent(); const a = await approve(p); const name = `delete-race-${randomUUID()}`;
    let started!: () => void; let release!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; }); const pause = new Promise<void>(resolve => { release = resolve; });
    const deleting = deleteAccount(database, p.account.userId, password, journal, p.context.session!, async (connection, accountId) => {
        await assertNoManagedChildren(connection, accountId); started(); await pause;
    });
    await ready;
    const creating = p.flow.createChild(p.context, { grant: a.proof.grant, userName: name, password });
    release(); assert.equal(await deleting, 'deleted'); assert.ok('error' in await creating);
    assert.equal((await admin.query<RowDataPacket[]>('SELECT user_id FROM users WHERE user_name=?', [name]))[0].length, 0);
    assert.equal((await admin.query<RowDataPacket[]>('SELECT child_uuid FROM parent_child_consents WHERE parent_uuid=?', [p.account.accountId]))[0].length, 0);
});

test('expiry maintenance removes proof metadata without removing active consent or the child', async () => {
    const p = await parent(); await child(p);
    await admin.query('UPDATE parent_registration_attempts SET expires_at=UTC_TIMESTAMP(6) WHERE parent_uuid=?', [p.account.accountId]);
    assert.deepEqual(await cleanupParentRegistrationAttempts(database), { backlog: false });
    assert.equal((await admin.query<RowDataPacket[]>('SELECT state_hash FROM parent_registration_attempts WHERE parent_uuid=?', [p.account.accountId]))[0].length, 0);
    assert.equal((await p.store.listChildren(p.context)).length, 1);
});
test('another parent cannot consume or cancel the grant or withdraw an unrelated child', async () => {
    const p = await parent(); const other = await parent(); const a = await approve(p);
    await other.flow.cancel(other.context, { state: a.challenge.state });
    assert.ok('error' in await other.flow.createChild(other.context, { grant: a.proof.grant, userName: 'stolen-child', password }));
    const created = await p.flow.createChild(p.context, { grant: a.proof.grant, userName: `owned-${randomUUID()}`, password }); assert.ok('created' in created);
    assert.ok('error' in await other.flow.begin(other.context, withdrawal(created.child.accountId)));
    assert.equal((await p.store.listChildren(p.context)).length, 1);
});
test('cancelled, expired and revoked-parent grants fail without orphan child rows', async () => {
    for (const mode of ['cancelled', 'expired', 'revoked']) {
        const p = await parent(); const a = await approve(p); const name = `${mode}-${randomUUID()}`;
        if (mode === 'cancelled') await p.flow.cancel(p.context, { state: a.challenge.state });
        if (mode === 'expired') await admin.query('UPDATE parent_registration_attempts SET expires_at=UTC_TIMESTAMP(6) WHERE parent_uuid=?', [p.account.accountId]);
        if (mode === 'revoked') await revokeAccountSession(database, p.account.userId, p.account.accountId, p.context.session!.sessionId);
        assert.ok('error' in await p.flow.createChild(p.context, { grant: a.proof.grant, userName: name, password }));
        assert.equal((await admin.query<RowDataPacket[]>('SELECT user_id FROM users WHERE user_name=?', [name]))[0].length, 0);
    }
});
test('parent deletion is blocked before journal intent; storage cannot orphan managed children', async () => {
    const p = await parent(); await child(p); const before = intents.length;
    await assert.rejects(deleteAccount(database, p.account.userId, password, journal, p.context.session!, assertNoManagedChildren), ManagedChildrenError);
    assert.equal(intents.length, before);
    await assert.rejects(admin.query('DELETE FROM users WHERE account_uuid=?', [p.account.accountId]), (error: unknown) => !!error && typeof error === 'object' && 'errno' in error && error.errno === 1451);
});
test('withdrawal journals exact child, removes its sessions/profile/scores and preserves parent', async () => {
    const p = await parent(); const c = await child(p); const [u] = (await admin.query<RowDataPacket[]>('SELECT user_id,user_password FROM users WHERE account_uuid=?', [c.child.accountId]))[0];
    const childSession = randomBytes(32).toString('base64url');
    await createAccountSession(database, { userId: u.user_id, accountId: c.child.accountId }, childSession, Math.floor(Date.now()/1000)+300, u.user_password);
    await submitP4VegaScore(database, u.user_id, 1000);
    assert.ok(!(await readP4VegaLeaderboard(database)).some(row => row.userName === c.child.userName));
    const a = await approve(p, withdrawal(c.child.accountId));
    assert.deepEqual(await p.flow.withdrawChild(p.context, { grant: a.proof.grant, confirmation: 'WITHDRAW AND DELETE' }), { deleted: true });
    assert.equal(intents.at(-1), c.child.accountId); assert.equal(await readLiveSession(database, u.user_id, c.child.accountId, childSession), null);
    assert.equal((await admin.query<RowDataPacket[]>('SELECT user_id FROM game_personal_bests WHERE user_id=?', [u.user_id]))[0].length, 0);
    assert.deepEqual(await p.store.listChildren(p.context), []);
    assert.ok(await readLiveSession(database, p.account.userId, p.account.accountId, p.context.session!.sessionId));
});
test('failed independent journal persistence rolls back withdrawal and leaves child and consent intact', async () => {
    const p = await parent(); const c = await child(p); const a = await approve(p, withdrawal(c.child.accountId));
    const broken = createParentRegistrationFlow({ policy, clients: p.clients, store: createParentRegistrationRepository(database,
        { async recordAccountDeletion() { throw new Error('synthetic journal outage'); } }) });
    assert.ok('error' in await broken.withdrawChild(p.context, { grant: a.proof.grant, confirmation: 'WITHDRAW AND DELETE' }));
    assert.equal((await p.store.listChildren(p.context)).length, 1);
    assert.deepEqual(await p.flow.withdrawChild(p.context, { grant: a.proof.grant, confirmation: 'WITHDRAW AND DELETE' }), { deleted: true });
});
test('pausing child creation retains withdrawal and listing for the existing parent', async () => {
    const p = await parent(); const c = await child(p);
    const paused = createParentRegistrationFlow({ policy: { ...policy, creationEnabled: false }, clients: p.clients, store: p.store });
    assert.deepEqual(await paused.begin(p.context, input), { error: 'CLOSED' });
    assert.ok('children' in await paused.listChildren(p.context, {}));
    const begin = await paused.begin(p.context, withdrawal(c.child.accountId)); assert.ok('state' in begin);
});

test('SQL cancellation wins while fresh provider verification is in flight', async () => {
    const p = await parent(); let release!: () => void; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; }); const pause = new Promise<void>(resolve => { release = resolve; });
    const flow = createParentRegistrationFlow({ policy, store: p.store, clients: { 'google-web': { provider: 'google', verifier: {
        async verify() { started(); await pause; return { verified: true, identity: p.identity }; },
    } } } });
    const b = await flow.begin(p.context, input); assert.ok('state' in b);
    const completing = flow.complete(p.context, { state: b.state, idToken: 'fixture' }); await ready;
    await flow.cancel(p.context, { state: b.state }); release();
    assert.deepEqual(await completing, { error: 'INVALID_ATTEMPT' });
});
test('withdrawal waits for the same child submission lock and cannot leave a score after deletion', async () => {
    const p = await parent(); const c = await child(p); const [u] = (await admin.query<RowDataPacket[]>('SELECT user_id FROM users WHERE account_uuid=?', [c.child.accountId]))[0];
    const a = await approve(p, withdrawal(c.child.accountId)); let release!: () => void; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; }); const pause = new Promise<void>(resolve => { release = resolve; });
    const submission = withUserSubmissionLock(database, u.user_id, async ({ connection }) => {
        started(); await pause;
        await connection.query("INSERT INTO game_personal_bests (game_id, rules_version, user_id, score, completion_time_ms, recorded_at) VALUES ('p4-vega', '1', ?, 100, NULL, UTC_TIMESTAMP(6))", [u.user_id]);
    });
    await ready; let finished = false;
    const deleting = p.flow.withdrawChild(p.context, { grant: a.proof.grant, confirmation: 'WITHDRAW AND DELETE' }).then(result => { finished = true; return result; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false); release();
    await submission; assert.deepEqual(await deleting, { deleted: true });
    assert.equal((await admin.query<RowDataPacket[]>('SELECT user_id FROM game_personal_bests WHERE user_id=?', [u.user_id]))[0].length, 0);
});
test('child accounts cannot create children or transfer their guardian relationship with runtime privileges', async () => {
    const p = await parent(); const c = await child(p); const [u] = (await admin.query<RowDataPacket[]>('SELECT user_id, user_password FROM users WHERE account_uuid=?', [c.child.accountId]))[0];
    const sessionId = randomBytes(32).toString('base64url');
    await createAccountSession(database, { userId: u.user_id, accountId: c.child.accountId }, sessionId, Math.floor(Date.now()/1000)+300, u.user_password);
    const context = { ...p.context, account: { userId: u.user_id, accountId: c.child.accountId }, session: { accountId: c.child.accountId, sessionId }, bindingHash: randomBytes(32) } as ProviderAuthContext;
    assert.ok('error' in await p.flow.begin(context, input));
    await assert.rejects(database.query('UPDATE parent_child_consents SET parent_uuid=? WHERE child_uuid=?', [randomUUID(), c.child.accountId]));
});

test('browser parent page creates and withdraws a private child through the real HTTP router and disposable SQL', async () => {
    const { createHmac } = await import('node:crypto');
    const { default: express } = await import('express'); const { default: cookieParser } = await import('cookie-parser');
    const { createAuthRouter } = await import('../routers/authRouter'); const { issueSessionToken } = await import('../security/sessionPolicy');
    const path = await import('node:path'); const { pathToFileURL } = await import('node:url');
    const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ createViteTestServer: Function }>;
    const { createViteTestServer } = await importModule(pathToFileURL(path.resolve('../frontend/ts/testSupport/createViteTestServer.mjs')).href);
    const { createRequire } = await import('node:module');
    const { chromium } = createRequire(path.resolve('../.github/firebase-deploy/registration-browser.test.mjs'))('playwright-core');
    const p = await parent(); const sessionSecret = 'synthetic-parent-browser-session-secret';
    const token = issueSessionToken({ ...p.account, userName: p.identity.subject }, sessionSecret);
    await createAccountSession(database, p.account, token.sessionId, token.expiresAt, passwordHash);
    const api = express(); api.use(cookieParser(sessionSecret)); api.use(express.json({ limit: '24kb' }));
    const http = api.listen(0, '127.0.0.1'); await once(http, 'listening');
    const address = http.address(); assert.ok(address && typeof address !== 'string');
    const frontendRoot = path.resolve('../frontend');
    const vite = await createViteTestServer({ root: frontendRoot, configFile: false, logLevel: 'error',
        resolve: { alias: { '@': `${frontendRoot}/ts` } }, esbuild: { jsx: 'automatic' },
        define: { 'import.meta.env.VITE_USE_PUBLIC_API': '"0"', 'import.meta.env.VITE_DEV_API_URL': '""' },
        server: { host: '127.0.0.1', port: 0, proxy: { '/auth': `http://127.0.0.1:${address.port}` } },
        plugins: [{ name: 'synthetic-parent-provider', enforce: 'pre', resolveId(source: string) {
            if (source.endsWith('/AuthContext')) return '\0synthetic-parent-auth';
            if (source.endsWith('/providerClient')) return '\0synthetic-parent-provider';
        }, load(id: string) {
            if (id === '\0synthetic-parent-auth') return `export const useAuth = () => ({ isAuthenticated: true, loading: false, userName: ${JSON.stringify(p.identity.subject)} });`;
            if (id === '\0synthetic-parent-provider') return 'export const getAvailableProviderClients = async () => [{clientKey:"google-web",provider:"google",platform:"web",clientId:"synthetic"}]; export const acquireProviderCredential = async () => "synthetic-browser-proof";';
        }, configureServer(server: { middlewares: { use: Function }; transformIndexHtml: Function }) {
            server.middlewares.use('/__parent-test', async (_req: unknown, res: { setHeader: Function; end: Function }) => {
                res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__parent-test', '<div id="root"></div><script type="module">import React from "react"; import {createRoot} from "react-dom/client"; import {BrowserRouter} from "react-router-dom"; import ParentAccounts from "/ts/pages/ParentAccounts.tsx"; createRoot(document.getElementById("root")).render(React.createElement(BrowserRouter,null,React.createElement(ParentAccounts)));</script>'));
            });
        } }], optimizeDeps: { include: ['react', 'react-dom/client', 'react-router-dom'] },
    }, { browser: true });
    let browser;
    try {
        await vite.listen(); const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
        api.use('/auth', createAuthRouter(database, sessionSecret, false, [origin], { accountDeletionEnabled: true, deletionJournal: journal,
            providerAuth: { enabled: true, clients: p.clients }, parentRegistrationStorageReady: true, parentRegistrationPolicy: policy }));
        browser = await chromium.launch({ channel: 'chrome', headless: true }); const context = await browser.newContext();
        await context.route('**/*', (route: { request: Function; abort: Function; continue: Function }) =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const signed = 's:' + token.token + '.' + createHmac('sha256', sessionSecret).update(token.token).digest('base64').replace(/=+$/u, '');
        await context.addCookies([{ name: '__session', value: encodeURIComponent(signed), url: origin, httpOnly: true, sameSite: 'Lax' }]);
        const page = await context.newPage(); page.setDefaultTimeout(15_000);
        page.on('pageerror', (error: Error) => console.error(error.message));
        await page.goto(`${origin}/__parent-test`);
        await page.getByLabel("Child's country").selectOption('ZZ');
        await page.getByLabel('I am 18 or older.').check(); await page.getByLabel("I am this child's parent or legal guardian and can give this consent.").check();
        await page.getByLabel('I agree to this child-account consent.').check();
        assert.equal(await page.locator('input[type=password]').count(), 0);
        await page.getByRole('button', { name: 'Confirm with Google', exact: true }).click();
        const nickname = `browser-${randomUUID()}`; await page.getByLabel("Child's nickname").fill(nickname); await page.getByLabel("Child's password").fill(password);
        await page.getByRole('button', { name: 'Create private child account', exact: true }).click();
        await page.getByText(`Created ${nickname} with private scores. You are still signed in to your parent account.`, { exact: true }).waitFor();
        const [created] = await p.store.listChildren(p.context); assert.equal(created.userName, nickname);
        const beforeDeletion = intents.length;
        // Keep this function self-contained when Playwright serializes it into the browser.
        const parentDeletion = await page.evaluate((syntheticPassword: string) =>
            fetch('/auth/delete-account', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: syntheticPassword, confirmation: 'DELETE' }) })
                .then(result => result.json().then(body => ({ status: result.status, body }))), password);
        assert.deepEqual(parentDeletion, { status: 409, body: { error: 'MANAGED_CHILDREN' } });
        assert.equal(intents.length, beforeDeletion);
        await page.getByLabel(/^Child account/).selectOption(created.accountId);
        await page.getByLabel('Type WITHDRAW AND DELETE').fill('WITHDRAW AND DELETE');
        await page.getByRole('button', { name: 'Confirm deletion with Google', exact: true }).click();
        await page.getByText('Consent withdrawn and child account deleted. Your parent account is unchanged.', { exact: true }).waitFor();
        assert.deepEqual(await p.store.listChildren(p.context), []);
    } finally { await browser?.close(); await vite.close(); http.close(); http.closeAllConnections(); await once(http, 'close'); }
});
