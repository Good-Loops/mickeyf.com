/** Synthetic proof against one independently verified disposable local MySQL container only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createRegistrationRouter } from '../routers/registrationRouter';
import { createProviderAuthContextReader } from '../auth/providerAuthContext';
import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { createRegistrationAuthorization, RegistrationRequiredError } from './registrationAuthorization';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import type { RegistrationPolicy } from '../config/registrationPolicy';

const image = 'mysql:8.0.31@sha256:3d7ae561cf6095f6aca8eb7830e1d14734227b1fb4748092f2be2cfbccf7d614';
const database = 'mickeyf_age_binding_proof';
const username = 'age_proof';
const password = 'age-proof-test-only';
let pool: Pool;

function assertTarget(): { port: number; id: string } {
    if (process.platform !== 'win32' || process.env.NODE_ENV !== 'test' || process.env.AGE_BINDING_PROOF_TEST !== '1'
        || process.env.AGE_BINDING_PROOF_HOST !== '127.0.0.1' || process.env.AGE_BINDING_PROOF_DATABASE !== database
        || process.env.AGE_BINDING_PROOF_USER !== username || process.env.AGE_BINDING_PROOF_PASSWORD !== password
        || ['DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CLOUD_SQL_CONNECTION_NAME']
            .some(key => process.env[key] !== undefined)) throw new Error('UNSAFE_SYNTHETIC_TEST_ENVIRONMENT');
    const port = Number(process.env.AGE_BINDING_PROOF_PORT);
    assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 3306);
    const id = process.env.AGE_BINDING_PROOF_CONTAINER_ID ?? '';
    const name = process.env.AGE_BINDING_PROOF_CONTAINER_NAME ?? '';
    if (!/^[a-f0-9]{64}$/u.test(id) || !/^ludolume-age-proof-[a-z0-9-]+$/u.test(name)) throw new Error('INVALID_SYNTHETIC_CONTAINER');
    const command = (...args: string[]) => {
        try { return execFileSync('docker', ['--context', 'desktop-linux', ...args],
            { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
        catch { throw new Error('SYNTHETIC_CONTAINER_INSPECTION_FAILED'); }
    };
    assert.equal(command('context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}'),
        'npipe:////./pipe/dockerDesktopLinuxEngine');
    const items = JSON.parse(command('inspect', '--type', 'container', id));
    assert.ok(Array.isArray(items) && items.length === 1);
    const item = items[0];
    assert.equal(item.Id, id); assert.equal(item.Name, `/${name}`); assert.equal(item.Config?.Image, image);
    assert.equal(item.Config?.Labels?.['com.ludolume.purpose'], 'age-binding-proof');
    assert.equal(item.Config?.Labels?.['com.ludolume.owner'], name);
    assert.equal(item.State?.Running, true); assert.equal(item.HostConfig?.Privileged, false);
    assert.deepEqual(item.HostConfig?.Tmpfs, { '/var/lib/mysql': 'rw,noexec,nosuid,size=512m' });
    assert.deepEqual(item.Mounts, []);
    assert.deepEqual(item.NetworkSettings?.Ports?.['3306/tcp'], [{ HostIp: '127.0.0.1', HostPort: String(port) }]);
    return { port, id };
}

async function connectWhenReady(port: number) {
    const until = Date.now() + 80_000;
    while (Date.now() < until) {
        try { return await mysql.createConnection({ host: '127.0.0.1', port, database, user: username, password,
            multipleStatements: false, dateStrings: true, timezone: 'Z', connectTimeout: 2_000 }); }
        catch { await new Promise(resolve => setTimeout(resolve, 1_000)); }
    }
    throw new Error('SYNTHETIC_DATABASE_NOT_READY');
}

before(async () => {
    const { port, id } = assertTarget();
    const probe = await connectWhenReady(port);
    try {
        const [target] = await probe.query<RowDataPacket[]>('SELECT DATABASE() AS db, CURRENT_USER() AS user, @@version AS version, @@version_comment AS vendor, @@hostname AS host');
        assert.equal(target[0].db, database); assert.equal(target[0].user, `${username}@%`);
        assert.match(target[0].version, /^8\.0\.31(?:-|$)/u); assert.doesNotMatch(target[0].vendor, /Google/iu);
        assert.equal(target[0].host, id.slice(0, 12));
        const [tables] = await probe.query<RowDataPacket[]>('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
        assert.deepEqual(tables, []);
        await probe.query(`CREATE TABLE registration_authorizations (
            binding_hash BINARY(32) NOT NULL PRIMARY KEY, policy_digest BINARY(32) NOT NULL,
            country_code CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            age_band ENUM('minor','adult') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            expires_at DATETIME(6) NOT NULL, consumed_at DATETIME(6) NULL,
            KEY idx_registration_expiry (expires_at)) ENGINE=InnoDB`);
        await probe.query(`CREATE TABLE account_registration_profiles (
            account_uuid CHAR(36) NOT NULL PRIMARY KEY, country_code CHAR(2) NOT NULL,
            age_band ENUM('minor','adult') NOT NULL, policy_version VARCHAR(64) NOT NULL,
            score_visibility ENUM('private','public') NOT NULL) ENGINE=InnoDB`);
    } finally { await probe.end(); }
    pool = mysql.createPool({ host: '127.0.0.1', port, database, user: username, password,
        multipleStatements: false, connectionLimit: 6, dateStrings: true, timezone: 'Z' });
});
after(async () => { if (pool) await pool.end(); });

const policy: RegistrationPolicy = { version: 'test', digest: Buffer.alloc(32, 3), audience: 'children-included',
    countries: { US: { parentRequiredBelow: 13 } } };
function binding(): ProviderAuthContext {
    return { bindingHash: randomBytes(32), account: null, session: null, bindingExpiresAt: Date.now() + 10 * 60_000,
        anonymousCookie: null, screening: true } as unknown as ProviderAuthContext;
}
const selection = (ageBand: string) => ({ country: 'US', policyVersion: 'test', ageBand });

test('younger observation invalidates the adult grant and cannot be reversed by cancel', async () => {
    const service = createRegistrationAuthorization(pool, policy);
    const context = binding();
    assert.equal((await service.begin(context, selection('adult'))).allowed, true);
    assert.equal((await service.begin(context, selection('parent-required'))).allowed, false);
    await service.cancel(context);
    assert.equal((await service.begin(context, selection('adult'))).allowed, false);
    await assert.rejects(service.assertAvailable(context), RegistrationRequiredError);
});

test('minor observation blocks an adult grant but permits a private minor account', async () => {
    const service = createRegistrationAuthorization(pool, policy);
    const context = binding();
    assert.equal((await service.begin(context, selection('adult'))).allowed, true);
    assert.equal((await service.begin(context, selection('minor'))).allowed, true);
    assert.equal((await service.begin(context, selection('adult'))).allowed, false);
    assert.equal((await service.begin(context, selection('minor'))).allowed, true);
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await service.consume(connection, context, '11111111-1111-4111-8111-111111111111');
        await connection.commit();
    } finally { connection.release(); }
    const [rows] = await pool.query<RowDataPacket[]>('SELECT age_band, score_visibility FROM account_registration_profiles');
    assert.deepEqual(rows.map(row => ({...row})), [{ age_band: 'minor', score_visibility: 'private' }]);
});

test('a session transaction and a younger observation serialize on the same binding', async () => {
    const service = createRegistrationAuthorization(pool, policy);
    const context = binding();
    assert.equal((await service.begin(context, selection('adult'))).allowed, true);
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    try {
        await service.assertLoginAvailableOnConnection(connection, context);
        let finished = false;
        const younger = service.begin(context, selection('parent-required')).then(value => { finished = true; return value; });
        const mutex = createHash('sha256').update('ludolume:age-screen:mutex:v1\0').update(context.bindingHash).digest();
        const observer = await pool.getConnection();
        try {
            await observer.beginTransaction();
            await assert.rejects(observer.query('SELECT binding_hash FROM registration_authorizations WHERE binding_hash=? FOR UPDATE NOWAIT', [mutex]),
                (error: unknown) => (error as {code?: string}).code === 'ER_LOCK_NOWAIT');
            await observer.rollback();
        } finally { observer.release(); }
        assert.equal(finished, false);
        await connection.commit();
        assert.equal((await younger).allowed, false);
        await assert.rejects(service.assertAvailable(context), RegistrationRequiredError);
    } finally { connection.release(); }
});

test('observe-only works while creation is paused, revokes an adult grant, and never issues another', async () => {
    const service = createRegistrationAuthorization(pool, policy, 'children-included', false);
    const context = binding();
    assert.equal((await service.begin(context, selection('adult'))).allowed, true);
    await service.assertLoginAvailable(context);
    assert.equal((await service.begin(context, selection('minor'), true)).allowed, true);
    await assert.rejects(service.assertLoginAvailable(context), RegistrationRequiredError);
    const [grants] = await pool.query<RowDataPacket[]>('SELECT binding_hash FROM registration_authorizations WHERE binding_hash=?', [context.bindingHash]);
    assert.deepEqual(grants, []);
    await service.begin(context, selection('parent-required'), true);
    await service.begin(context, selection('minor'), true);
    assert.equal((await service.begin(context, selection('adult'))).allowed, false);
    assert.equal((await service.begin(context, selection('minor'))).allowed, false);
});

test('malformed marker fails closed instead of being mistaken for no restriction', async () => {
    const service = createRegistrationAuthorization(pool, policy);
    const context = binding();
    const key = createHash('sha256').update('ludolume:age-screen:parent:v1\0').update(context.bindingHash).digest();
    await pool.query(`INSERT INTO registration_authorizations (binding_hash, policy_digest, country_code, age_band, expires_at)
        VALUES (?, ?, 'ZZ', 'minor', UTC_TIMESTAMP(6) + INTERVAL 1 MINUTE)`, [key, Buffer.alloc(32, 9)]);
    await assert.rejects(service.begin(context, selection('adult')), RegistrationRequiredError);
});

test('unresolved native check blocks grants, invalidates earlier eligibility, and cannot be cleared by another token', async () => {
    const service = createRegistrationAuthorization(pool, policy);
    const context = binding();
    await service.begin(context, selection('adult'));
    const attempt = await service.beginNativeAgeCheck(context);
    assert.match(attempt, /^[A-Za-z0-9_-]{43}$/u);
    await assert.rejects(service.assertLoginAvailable(context), RegistrationRequiredError);
    await assert.rejects(service.begin(context, selection('adult')), RegistrationRequiredError);
    await assert.rejects(service.beginNativeAgeCheck(context), RegistrationRequiredError);
    await assert.rejects(service.finishNativeAgeCheck(context, 'A'.repeat(43), selection('adult')), RegistrationRequiredError);
    await assert.rejects(service.begin(context, selection('adult')), RegistrationRequiredError);
    await service.begin(context, selection('minor'), true);
    await service.finishNativeAgeCheck(context, attempt, selection('adult'));
    assert.equal((await service.begin(context, selection('adult'))).allowed, false);
    assert.equal((await service.begin(context, selection('minor'))).allowed, true);
    await assert.rejects(service.finishNativeAgeCheck(context, attempt, selection('adult')), RegistrationRequiredError);
});

test('native pending reservation and concurrent session completion use the same real row lock', async () => {
    const service = createRegistrationAuthorization(pool, policy);
    const context = binding();
    await service.begin(context, selection('adult'));
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await service.assertLoginAvailableOnConnection(connection, context);
        let reserved = false;
        const waiting = service.beginNativeAgeCheck(context).then(value => { reserved = true; return value; });
        const mutex = createHash('sha256').update('ludolume:age-screen:mutex:v1\0').update(context.bindingHash).digest();
        const observer = await pool.getConnection();
        try {
            await observer.beginTransaction();
            await assert.rejects(observer.query('SELECT binding_hash FROM registration_authorizations WHERE binding_hash=? FOR UPDATE NOWAIT', [mutex]),
                (error: unknown) => (error as {code?: string}).code === 'ER_LOCK_NOWAIT');
            await observer.rollback();
        } finally { observer.release(); }
        assert.equal(reserved, false);
        await connection.commit();
        const token = await waiting;
        await assert.rejects(service.assertLoginAvailable(context), RegistrationRequiredError);
        await service.finishNativeAgeCheck(context, token, selection('parent-required'));
    } finally { connection.release(); }
    assert.equal((await service.begin(context, selection('adult'))).allowed, false);
});

test('HTTP native reservation blocks an adult attempt until the matching younger result', async () => {
    const secret = 'synthetic-native-screening-test-secret';
    const origin = 'https://screening.example.test';
    const service = createRegistrationAuthorization(pool, policy);
    const app = express(); app.use(cookieParser(secret));
    app.use('/auth/registration', createRegistrationRouter(service,
        createProviderAuthContextReader({ database: pool, sessionSecret: secret, allowedOrigins: [origin] }), false));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/registration`;
    const post = (route: string, body: unknown, cookie?: string) => fetch(`${base}${route}`, { method: 'POST',
        headers: { origin, ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
        const boot = await post('/bootstrap', {}); assert.equal(boot.status, 200);
        const cookie = boot.headers.get('set-cookie')!.split(';')[0];
        const start = await post('/age-check/start', {}, cookie); assert.equal(start.status, 200);
        const { attempt } = await start.json() as { attempt: string };
        const adult = await post('/begin', selection('adult'), cookie); assert.equal(adult.status, 403);
        const finish = await post('/age-check/finish', { attempt, ...selection('parent-required') }, cookie);
        assert.equal(finish.status, 200); assert.deepEqual(await finish.json(), { observed: true });
        const retry = await post('/begin', selection('adult'), cookie); assert.equal(retry.status, 403);
        assert.deepEqual(await retry.json(), { error: 'PARENT_REQUIRED' });
        const replay = await post('/age-check/finish', { attempt, ...selection('adult') }, cookie); assert.equal(replay.status, 403);
    } finally { server.close(); server.closeAllConnections(); await once(server, 'close'); }
});

test('an expired native reservation cannot be finished or issue a grant', async () => {
    const service = createRegistrationAuthorization(pool, policy);
    const context = binding();
    const attempt = await service.beginNativeAgeCheck(context);
    const expired = { ...context, bindingExpiresAt: Date.now() - 1 } as ProviderAuthContext;
    await assert.rejects(service.finishNativeAgeCheck(expired, attempt, selection('adult')), RegistrationRequiredError);
    await assert.rejects(service.begin(expired, selection('adult')), RegistrationRequiredError);
    const freshContext = binding();
    assert.equal((await service.begin(freshContext, selection('adult'))).allowed, true);
});


test('native reservation needs five minutes plus a transaction margin without extending the binding', async () => {
    const service = createRegistrationAuthorization(pool, policy);
    const context = binding();
    await service.begin(context, selection('adult'));
    const tooLate = { ...context, bindingExpiresAt: Date.now() + 5 * 60_000 + 9_000 } as ProviderAuthContext;
    await assert.rejects(service.beginNativeAgeCheck(tooLate), RegistrationRequiredError);
    await service.assertAvailable(context);
    const [pending] = await pool.query<RowDataPacket[]>('SELECT binding_hash FROM registration_authorizations WHERE binding_hash=?',
        [createHash('sha256').update('ludolume:age-screen:pending:v1\0').update(context.bindingHash).digest()]);
    assert.deepEqual(pending, []);
    const enoughTime = { ...context, bindingExpiresAt: Date.now() + 5 * 60_000 + 15_000 } as ProviderAuthContext;
    const attempt = await service.beginNativeAgeCheck(enoughTime);
    assert.match(attempt, /^[A-Za-z0-9_-]{43}$/u);
    const [rows] = await pool.query<RowDataPacket[]>(`SELECT CAST(UNIX_TIMESTAMP(expires_at) * 1000 AS UNSIGNED) AS expiry
        FROM registration_authorizations WHERE binding_hash=?`,
    [createHash('sha256').update('ludolume:age-screen:pending:v1\0').update(context.bindingHash).digest()]);
    assert.equal(Number(rows[0].expiry), enoughTime.bindingExpiresAt);
    await service.finishNativeAgeCheck(enoughTime, attempt, selection('adult'));
});
