import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import cookieParser from 'cookie-parser';
import express from 'express';
import mysql, { type Connection, type Pool, type RowDataPacket } from 'mysql2/promise';
import { guardConnectionQueries } from '../db/queryTimeoutConnection';
import { cleanupChildDailyUsage, configureChildDailyUsage, readChildDailyUsage } from './childDailyUsageStore';
import { clearChildDailyUsageLimit, getChildDailyUsageLimit, heartbeatChildDailyUsage, setChildDailyUsageLimit } from './childDailyUsageService';
import { createProviderAuthContextReader, type ProviderAuthContext } from '../auth/providerAuthContext';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { verifyChildDailyUsageSchema } from '../migrations/childDailyUsageSchema';
import { issueSessionToken } from '../security/sessionPolicy';
import { createGeneralApiRateLimiter } from '../security/requestRateLimits';
import { renderRuntimeGrantStatements } from '../security/runtimeGrantManifest';
import { createChildDailyUsageHeartbeatRouter, createChildDailyUsageRouter } from '../routers/childDailyUsageRouter';

let admin: Connection;
let pool: Pool;
const child = randomUUID();
const policy = { timeZone: 'America/Sao_Paulo', dailyLimitMs: 120_000 };
// The rehearsal executes a fixed statement only after the draft matches it.
const reviewedDraft = `-- Draft only: do not apply until grants, deletion/recovery and rollout are qualified.
-- One current-day aggregate per managed child; no individual activity log.
CREATE TABLE parent_child_daily_usage (
    child_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    time_zone VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    daily_limit_ms INT UNSIGNED NOT NULL,
    usage_day CHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    used_ms INT UNSIGNED NOT NULL,
    accounted_at_ms BIGINT UNSIGNED NOT NULL,
    active_until_ms BIGINT UNSIGNED NULL,
    PRIMARY KEY (child_uuid),
    KEY idx_child_daily_usage_accounted_at (accounted_at_ms),
    CONSTRAINT fk_child_daily_usage_consent FOREIGN KEY (child_uuid)
        REFERENCES parent_child_consents (child_uuid) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT chk_child_daily_usage_bounds CHECK (
        daily_limit_ms BETWEEN 60000 AND 86400000 AND used_ms <= 86400000
        AND (active_until_ms IS NULL OR (active_until_ms >= accounted_at_ms
            AND active_until_ms <= accounted_at_ms + 30000))
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`;

before(async () => {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.MIGRATION_TEST_ENABLED, '1');
    assert.equal(process.env.MIGRATION_TEST_HOST, '127.0.0.1');
    assert.equal(process.env.MIGRATION_TEST_DATABASE, 'mickeyf_migration_test');
    assert.equal(process.env.MIGRATION_TEST_USER, 'migration_test');
    assert.equal(process.env.MIGRATION_TEST_ROOT_PASSWORD, 'migration-test-root-only');
    const port = Number(process.env.MIGRATION_TEST_PORT);
    assert.ok(Number.isInteger(port) && port > 0 && port !== 3306);
    for (const key of ['DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CLOUD_SQL_CONNECTION_NAME']) assert.equal(process.env[key], undefined);
    admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root',
        password: 'migration-test-root-only', database: 'mickeyf_migration_test', timezone: 'Z' });
    const [target] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db, @@version AS version, @@version_comment AS vendor');
    assert.equal(target[0].db, 'mickeyf_migration_test');
    assert.match(target[0].version, /^8\.0\.31(?:-|$)/u);
    assert.doesNotMatch(target[0].vendor, /Google/iu);
    await admin.query('CREATE DATABASE child_usage_test');
    await admin.query(`CREATE TABLE child_usage_test.parent_child_consents (
        child_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        parent_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL
    ) ENGINE=InnoDB`);
    await admin.query('USE child_usage_test');
    await admin.query(`CREATE TABLE users (user_id INT NOT NULL PRIMARY KEY, user_name VARCHAR(64) NOT NULL,
        account_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE) ENGINE=InnoDB`);
    await admin.query(`CREATE TABLE account_sessions (account_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        session_hash BINARY(32) NOT NULL, previous_session_hash BINARY(32) NULL,
        previous_valid_until DATETIME(6) NULL, expires_at DATETIME(6) NOT NULL) ENGINE=InnoDB`);
    const draft = readFileSync(path.join(__dirname, '../../migrations/pending/draft_parent_child_daily_usage.sql'), 'utf8');
    assert.equal(draft.replace(/\r\n/gu, '\n').trim(), reviewedDraft);
    await admin.query(reviewedDraft);
    await verifyChildDailyUsageSchema(admin as unknown as MigrationConnection);
    await admin.query('INSERT INTO parent_child_consents (child_uuid) VALUES (?)', [child]);
    const usageGrant = "GRANT SELECT (`child_uuid`, `time_zone`, `daily_limit_ms`, `usage_day`, `used_ms`, `accounted_at_ms`, `active_until_ms`), INSERT (`child_uuid`, `time_zone`, `daily_limit_ms`, `usage_day`, `used_ms`, `accounted_at_ms`, `active_until_ms`), UPDATE (`time_zone`, `daily_limit_ms`, `usage_day`, `used_ms`, `accounted_at_ms`, `active_until_ms`), DELETE ON `child_usage_test`.`parent_child_daily_usage` TO 'migration_test'@'%';";
    assert.equal(renderRuntimeGrantStatements('child_usage_test', { user: 'migration_test', host: '%' },
        'google-apple-parent-signed-recovery-usage').slice(-1)[0], usageGrant);
    await admin.query(usageGrant);
    for (const table of ['users', 'account_sessions', 'parent_child_consents']) {
        await admin.query(`GRANT SELECT ON child_usage_test.${table} TO 'migration_test'@'%'`);
    }
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'migration_test', password: 'migration-test-only',
        database: 'child_usage_test', timezone: 'Z', dateStrings: true });
});

test('only the linked parent and a live managed child session can access usage', async () => {
    const parent = randomUUID(), other = randomUUID(), managed = randomUUID();
    const makeContext = async (userId: number, accountId: string) => {
        const sessionId = randomBytes(32).toString('base64url');
        await admin.query('INSERT INTO users VALUES (?, ?, ?)', [userId, `fictional-${userId}`, accountId]);
        await admin.query('INSERT INTO account_sessions (account_uuid, session_hash, expires_at) VALUES (?, ?, UTC_TIMESTAMP(6) + INTERVAL 1 HOUR)',
            [accountId, createHash('sha256').update(sessionId, 'ascii').digest()]);
        return { account: { userId, accountId }, session: { accountId, sessionId }, bindingHash: randomBytes(32),
            bindingExpiresAt: null, anonymousCookie: null } as ProviderAuthContext;
    };
    const owner = await makeContext(1, parent), stranger = await makeContext(2, other), childContext = await makeContext(3, managed);
    await admin.query('INSERT INTO parent_child_consents (child_uuid, parent_uuid) VALUES (?, ?)', [managed, parent]);
    assert.equal(await getChildDailyUsageLimit(pool, owner, managed), null);
    await assert.rejects(setChildDailyUsageLimit(pool, stranger, managed, policy), /Child unavailable/u);
    await setChildDailyUsageLimit(pool, owner, managed, policy);
    await assert.rejects(pool.query('UPDATE parent_child_daily_usage SET child_uuid=? WHERE child_uuid=?', [randomUUID(), managed]));
    await assert.rejects(pool.query('DELETE FROM parent_child_consents WHERE child_uuid=?', [managed]));
    const heartbeat = await heartbeatChildDailyUsage(pool, childContext);
    assert.equal(heartbeat.status, 'configured');
    assert.equal((await getChildDailyUsageLimit(pool, owner, managed))?.dailyLimitMs, policy.dailyLimitMs);
    await assert.rejects(clearChildDailyUsageLimit(pool, stranger, managed), /Child unavailable/u);
    await clearChildDailyUsageLimit(pool, owner, managed);
    assert.equal((await heartbeatChildDailyUsage(pool, childContext)).status, 'not-configured');
    await setChildDailyUsageLimit(pool, owner, managed, policy);
    await admin.query('DELETE FROM account_sessions WHERE account_uuid=?', [parent]);
    await assert.rejects(getChildDailyUsageLimit(pool, owner, managed), /Session unavailable/u);
    await admin.query('DELETE FROM parent_child_consents WHERE child_uuid=?', [managed]);
    assert.equal((await heartbeatChildDailyUsage(pool, childContext)).status, 'not-managed');
});

test('signed parent and child sessions can set and use a limit through the candidate HTTP routes', async () => {
    const secret = 'synthetic-usage-http-session-secret', origin = 'https://example.test';
    const parentId = randomUUID(), childId = randomUUID();
    const fixture = async (userId: number, accountId: string) => {
        const userName = `fictional-${userId}`;
        await admin.query('INSERT INTO users VALUES (?, ?, ?)', [userId, userName, accountId]);
        const issued = issueSessionToken({ userId, userName, accountId }, secret);
        await admin.query(`INSERT INTO account_sessions (account_uuid, session_hash, expires_at)
            VALUES (?, ?, TIMESTAMPADD(SECOND, ?, '1970-01-01 00:00:00'))`,
        [accountId, createHash('sha256').update(issued.sessionId, 'ascii').digest(), issued.expiresAt]);
        return issued.token;
    };
    const parentToken = await fixture(10, parentId), childToken = await fixture(11, childId);
    await admin.query('INSERT INTO parent_child_consents (child_uuid, parent_uuid) VALUES (?, ?)', [childId, parentId]);
    const app = express(); app.use(cookieParser(secret));
    app.get('/fixture/:who', (req, res) => res.cookie('__session', req.params.who === 'parent' ? parentToken : childToken,
        { signed: true, httpOnly: true }).status(204).end());
    const readContext = createProviderAuthContextReader({ database: pool, sessionSecret: secret, allowedOrigins: [origin] });
    app.use('/auth/child-daily-usage/heartbeat', createChildDailyUsageHeartbeatRouter(pool, readContext));
    app.use('/auth', createGeneralApiRateLimiter());
    app.use('/auth/child-daily-usage', createChildDailyUsageRouter(pool, readContext));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
        const address = server.address(); assert.ok(address && typeof address !== 'string');
        const base = `http://127.0.0.1:${address.port}`;
        const getCookie = async (who: string) => {
            const response = await fetch(`${base}/fixture/${who}`);
            const cookie = response.headers.get('set-cookie'); assert.ok(cookie); return cookie.split(';')[0];
        };
        const parentCookie = await getCookie('parent'), childCookie = await getCookie('child');
        const post = (route: string, cookie: string, body: object, requestOrigin = origin) => fetch(`${base}/auth/child-daily-usage/${route}`, {
            method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
        });
        assert.equal((await post('heartbeat', childCookie, {}, 'https://other.example.test')).status, 403);
        const before = await post('heartbeat', childCookie, {});
        assert.equal((await before.json()).status, 'not-configured');
        const configured = await post('set', parentCookie, { childAccountId: childId, ...policy });
        assert.equal(configured.status, 200);
        assert.equal((await configured.json()).usage.dailyLimitMs, policy.dailyLimitMs);
        const heartbeat = await post('heartbeat', childCookie, {});
        const result = await heartbeat.json();
        assert.equal(result.status, 'configured'); assert.ok(result.allowedForMs > 0 && result.allowedForMs <= 30_000);
        assert.notEqual((await post('set', childCookie, { childAccountId: childId, ...policy })).status, 200);
        assert.equal((await post('clear', parentCookie, { childAccountId: childId })).status, 204);
        assert.equal((await (await post('heartbeat', childCookie, {})).json()).status, 'not-configured');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
after(async () => { if (pool) await pool.end(); if (admin) await admin.end(); });

test('daily settings persist under a guarded transaction and consent deletion cascades', async () => {
    const connection = guardConnectionQueries(await pool.getConnection());
    try {
        await assert.rejects(readChildDailyUsage(connection, child, false), /guarded transaction/u);
        await connection.query('START TRANSACTION');
        assert.equal(await readChildDailyUsage(connection, child, false), null);
        const created = await configureChildDailyUsage(connection, child, policy);
        assert.equal(created.state.usedMs, 0);
        const started = await readChildDailyUsage(connection, child, true);
        assert.ok(started?.allowedUntilMs);
        const viewed = await readChildDailyUsage(connection, child, false);
        assert.ok(viewed?.state.activeUntilMs);
        const changed = await configureChildDailyUsage(connection, child, { timeZone: 'UTC', dailyLimitMs: 60_000 });
        assert.ok(changed.state.usedMs >= viewed.state.usedMs);
        await connection.query('COMMIT');

        const [rows] = await admin.query<RowDataPacket[]>('SELECT time_zone, daily_limit_ms FROM parent_child_daily_usage WHERE child_uuid=?', [child]);
        assert.deepEqual([rows[0].time_zone, rows[0].daily_limit_ms], ['UTC', 60_000]);
        await assert.rejects(admin.query('UPDATE parent_child_daily_usage SET daily_limit_ms=1 WHERE child_uuid=?', [child]));
        await admin.query('DELETE FROM parent_child_consents WHERE child_uuid=?', [child]);
        const [remaining] = await admin.query<RowDataPacket[]>('SELECT child_uuid FROM parent_child_daily_usage WHERE child_uuid=?', [child]);
        assert.equal(remaining.length, 0);
    } finally { connection.release(); }
});

test('retention removes stale totals without removing the parent setting or recent use', async () => {
    const stale = randomUUID(), recent = randomUUID();
    await admin.query('INSERT INTO parent_child_consents (child_uuid) VALUES (?), (?)', [stale, recent]);
    const connection = guardConnectionQueries(await pool.getConnection());
    try {
        await connection.query('START TRANSACTION');
        await configureChildDailyUsage(connection, stale, { ...policy, timeZone: 'UTC' });
        await configureChildDailyUsage(connection, recent, { ...policy, timeZone: 'UTC' });
        await connection.query('COMMIT');
        await admin.query(`UPDATE parent_child_daily_usage SET used_ms=15000,
            usage_day=DATE_FORMAT(UTC_TIMESTAMP() - INTERVAL 3 DAY, '%Y-%m-%d'),
            accounted_at_ms=(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000) - 259200000
            WHERE child_uuid=?`, [stale]);
        await admin.query('UPDATE parent_child_daily_usage SET used_ms=9000 WHERE child_uuid=?', [recent]);
        assert.deepEqual(await cleanupChildDailyUsage(pool), { cleared: 1, mayHaveMore: false });
        const [rows] = await admin.query<RowDataPacket[]>('SELECT child_uuid, used_ms, daily_limit_ms FROM parent_child_daily_usage WHERE child_uuid IN (?, ?)', [stale, recent]);
        const byId = new Map(rows.map(row => [row.child_uuid, row]));
        assert.equal(byId.get(stale)?.used_ms, 0);
        assert.equal(byId.get(stale)?.daily_limit_ms, policy.dailyLimitMs);
        assert.equal(byId.get(recent)?.used_ms, 9000);
        assert.deepEqual(await cleanupChildDailyUsage(pool), { cleared: 0, mayHaveMore: false });
    } finally { connection.release(); }
});

test('schema verification rejects a weakened retention relationship or bounds', async () => {
    await admin.query('ALTER TABLE parent_child_daily_usage DROP FOREIGN KEY fk_child_daily_usage_consent');
    try {
        await assert.rejects(verifyChildDailyUsageSchema(admin as unknown as MigrationConnection), /schema differs/u);
    } finally {
        await admin.query(`ALTER TABLE parent_child_daily_usage ADD CONSTRAINT fk_child_daily_usage_consent FOREIGN KEY (child_uuid)
            REFERENCES parent_child_consents (child_uuid) ON DELETE CASCADE ON UPDATE RESTRICT`);
    }
    await verifyChildDailyUsageSchema(admin as unknown as MigrationConnection);
    await admin.query('ALTER TABLE parent_child_daily_usage DROP CHECK chk_child_daily_usage_bounds');
    await admin.query('ALTER TABLE parent_child_daily_usage ADD CONSTRAINT chk_child_daily_usage_bounds CHECK (1=1)');
    try {
        await assert.rejects(verifyChildDailyUsageSchema(admin as unknown as MigrationConnection), /schema differs/u);
    } finally {
        await admin.query('ALTER TABLE parent_child_daily_usage DROP CHECK chk_child_daily_usage_bounds');
        await admin.query(`ALTER TABLE parent_child_daily_usage ADD CONSTRAINT chk_child_daily_usage_bounds CHECK (
            daily_limit_ms BETWEEN 60000 AND 86400000 AND used_ms <= 86400000
            AND (active_until_ms IS NULL OR (active_until_ms >= accounted_at_ms
                AND active_until_ms <= accounted_at_ms + 30000)))`);
    }
    await verifyChildDailyUsageSchema(admin as unknown as MigrationConnection);
});
