import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { createAppleAndroidHandoffCrypto, AppleAndroidHandoffError,
    type AppleAndroidHandoffBinding } from './appleAndroidHandoffCrypto';
import { createAppleAndroidHandoffRepository } from './appleAndroidHandoffRepository';
import { verifyAppleAndroidHandoffSchema, verifyAppleAndroidHandoffReadiness,
    APPLE_ANDROID_HANDOFF_MIGRATION } from '../migrations/appleAndroidHandoffSchema';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { consumeProviderAttempt, createProviderAttempt } from './providerAttemptRepository';

// Execute only reviewed literals. Filesystem contents are comparison data, never executable SQL.
const PROVIDER_ATTEMPT_SQL = `CREATE TABLE provider_auth_attempts (
    state_hash BINARY(32) NOT NULL,
    binding_hash BINARY(32) NOT NULL,
    nonce CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    client_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    action VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id INT NULL,
    account_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    expires_at DATETIME(6) NOT NULL COMMENT 'UTC',
    CONSTRAINT pk_provider_auth_attempts PRIMARY KEY (state_hash),
    CONSTRAINT uq_provider_auth_attempt_binding UNIQUE (binding_hash),
    INDEX idx_provider_auth_attempt_account (account_uuid),
    INDEX idx_provider_auth_attempt_expiry (expires_at),
    CONSTRAINT fk_provider_auth_attempt_account FOREIGN KEY (account_uuid)
        REFERENCES users (account_uuid) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT chk_provider_auth_attempt_action CHECK (
        CAST(action AS BINARY) IN (CAST('login' AS BINARY), CAST('link' AS BINARY))
    ),
    -- MySQL prohibits CHECK on a cascading foreign-key column. The repository
    -- validates the paired UUID shape when writing and consuming each attempt.
    CONSTRAINT chk_provider_auth_attempt_user CHECK (
        CASE WHEN CAST(action AS BINARY) = CAST('login' AS BINARY)
            THEN user_id IS NULL
            ELSE COALESCE(user_id > 0, 0)
        END = 1
    )
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
`;
const EXTENDED_ATTEMPT_SQL = `ALTER TABLE provider_auth_attempts
    DROP CHECK chk_provider_auth_attempt_action,
    DROP CHECK chk_provider_auth_attempt_user,
    ADD CONSTRAINT chk_provider_auth_attempt_action CHECK (
        CAST(action AS BINARY) IN (
            CAST('login' AS BINARY), CAST('link' AS BINARY),
            CAST('signup' AS BINARY), CAST('delete' AS BINARY)
        )
    ),
    ADD CONSTRAINT chk_provider_auth_attempt_user CHECK (
        CASE WHEN CAST(action AS BINARY) IN (CAST('login' AS BINARY), CAST('signup' AS BINARY))
            THEN user_id IS NULL
            ELSE COALESCE(user_id > 0, 0)
        END = 1
    );
`;
const ANDROID_HANDOFF_SQL = `CREATE TABLE apple_android_handoffs (
    state_hash BINARY(32) NOT NULL,
    binding_hash BINARY(32) NOT NULL,
    nonce CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    client_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    action VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    account_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    user_id INT NULL,
    phase ENUM('pending','ready') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    encrypted_credential VARBINARY(24576) NULL,
    created_at DATETIME(6) NOT NULL COMMENT 'UTC',
    expires_at DATETIME(6) NOT NULL COMMENT 'UTC',
    PRIMARY KEY (state_hash),
    UNIQUE KEY uq_apple_android_handoff_binding (binding_hash),
    KEY idx_apple_android_handoff_expiry (expires_at),
    CONSTRAINT fk_apple_android_handoff_attempt FOREIGN KEY (state_hash)
        REFERENCES provider_auth_attempts (state_hash) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT chk_apple_android_handoff_client CHECK (BINARY client_key = BINARY 'apple-android'),
    CONSTRAINT chk_apple_android_handoff_target CHECK (
        (BINARY action IN (BINARY 'login', BINARY 'signup') AND account_uuid IS NULL AND user_id IS NULL)
        OR (BINARY action IN (BINARY 'link', BINARY 'delete') AND account_uuid IS NOT NULL AND user_id IS NOT NULL AND user_id > 0)
    ),
    CONSTRAINT chk_apple_android_handoff_phase CHECK (
        (phase = 'pending' AND encrypted_credential IS NULL)
        OR (phase = 'ready' AND encrypted_credential IS NOT NULL AND OCTET_LENGTH(encrypted_credential) > 31)
    ),
    CONSTRAINT chk_apple_android_handoff_lifetime CHECK (
        expires_at > created_at AND expires_at <= TIMESTAMPADD(SECOND, 300, created_at)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;
function assertMigrationFixtureSources() {
    for (const [filename, literal] of [
        ['0010_create_provider_auth_attempts.sql', PROVIDER_ATTEMPT_SQL],
        ['0015_extend_provider_attempt_actions.sql', EXTENDED_ATTEMPT_SQL],
        ['pending/0027_create_apple_android_handoffs.sql', ANDROID_HANDOFF_SQL],
    ]) {
        const source = readFileSync(path.join(__dirname, '../../migrations', filename), 'utf8');
        assert.equal(source.replace(/\r\n/gu, '\n'), literal, `Reviewed SQL fixture must match ${filename}`);
    }
}

test('reviewed literal SQL fixture exactly matches migration sources', assertMigrationFixtureSources);

if (process.env.APPLE_ANDROID_HANDOFF_TEST_ENABLED !== '1') {
    test('Apple Android handoff SQL requires the disposable local harness', { skip: true }, () => {});
} else {
    let pool: Pool;
    const settings = { clientId: 'com.example.web', activeKeyId: 'synthetic', encryptionKeys: { synthetic: randomBytes(32) } };
    const cipher = createAppleAndroidHandoffCrypto(settings);
    const credential = { idToken: 'synthetic.id.token', authorizationCode: 'synthetic-private-code' };
    let store: ReturnType<typeof createAppleAndroidHandoffRepository>;
    const proofs = new Map<string, string>();
    async function completeCallback(value: AppleAndroidHandoffBinding, input: typeof credential) {
        const proof = await store.completeCallback(value, input);
        if (proof) proofs.set(value.stateHash.toString('hex'), proof);
        return proof;
    }
    function redeem(value: AppleAndroidHandoffBinding, proof?: string) {
        return store.redeem(value, proof ?? proofs.get(value.stateHash.toString('hex')) ?? 'A'.repeat(43));
    }
    const binding = (): AppleAndroidHandoffBinding => ({ stateHash: randomBytes(32), bindingHash: randomBytes(32),
        nonce: randomBytes(32).toString('base64url'), clientKey: 'apple-android', action: 'login',
        accountId: null, userId: null, expiresAt: Date.now() + 240_000 });
    const date = (time: number) => new Date(time).toISOString().replace('T', ' ').slice(0, -1);
    async function createHandoff(value: AppleAndroidHandoffBinding) {
        await pool.query(`REPLACE INTO provider_auth_attempts
            (state_hash,binding_hash,nonce,client_key,action,user_id,account_uuid,expires_at) VALUES (?,?,?,?,?,?,?,?)`,
        [value.stateHash,value.bindingHash,value.nonce,value.clientKey,value.action,value.userId,value.accountId,date(value.expiresAt)]);
        return store.create(value);
    }
    async function count() { return Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM apple_android_handoffs'))[0][0].n); }
    async function fill(amount: number, expired = false) {
        const expiry = expired ? Date.now() - 60_000 : Date.now() + 240_000;
        const created = expiry - 240_000;
        const date = (time: number) => new Date(time).toISOString().replace('T',' ').slice(0,-1);
        const rows = Array.from({length:amount},()=>[randomBytes(32),randomBytes(32),randomBytes(32).toString('base64url'),
            'apple-android','login',null,null,'pending',null,date(created),date(expiry)]);
        await pool.query('INSERT INTO provider_auth_attempts (state_hash,binding_hash,nonce,client_key,action,user_id,account_uuid,expires_at) VALUES ?',
            [rows.map(row=>[...row.slice(0,7),row[10]])]);
        await pool.query('INSERT INTO apple_android_handoffs VALUES ?', [rows]);
    }
    before(async () => {
        assertMigrationFixtureSources();
        assert.equal(process.env.NODE_ENV, 'test');
        assert.match(process.env.APPLE_ANDROID_HANDOFF_TEST_CONTAINER ?? '', /^[a-f0-9]{64}$/u);
        for (const key of ['DATABASE_URL','DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASS','CLOUD_SQL_CONNECTION_NAME']) {
            assert.equal(process.env[key],undefined);
        }
        const port = Number(process.env.APPLE_ANDROID_HANDOFF_TEST_PORT);
        assert.ok(Number.isInteger(port) && port > 0 && port <= 65535 && port !== 3306);
        pool = mysql.createPool({host:'127.0.0.1',port,user:'migration_test',password:'migration-test-only',
            database:'mickeyf_migration_test',connectionLimit:12,connectTimeout:10000,dateStrings:true,timezone:'Z',multipleStatements:false});
        const [rows] = await pool.query<RowDataPacket[]>('SELECT DATABASE() AS db, CURRENT_USER() AS user, @@version AS version, @@version_comment AS comment');
        assert.equal(rows[0].db,'mickeyf_migration_test');
        assert.equal(rows[0].user,'migration_test@%');
        assert.match(rows[0].version,/^8\.0\.31(?:-|$)/u);
        assert.doesNotMatch(rows[0].comment,/Google/iu);
        const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES');
        assert.equal(tables.length,0,'new disposable database must be empty before DDL');
        await pool.query(`CREATE TABLE users (account_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY)`);
        await pool.query("INSERT INTO users VALUES ('123e4567-e89b-42d3-a456-426614174000')");
        await pool.query(PROVIDER_ATTEMPT_SQL);
        await pool.query(EXTENDED_ATTEMPT_SQL);
        await pool.query(ANDROID_HANDOFF_SQL);
        store = createAppleAndroidHandoffRepository(pool,cipher);
    });
    after(async()=>{await pool?.end();});
    beforeEach(async()=>{proofs.clear();await pool.query('DELETE FROM apple_android_handoffs');await pool.query('DELETE FROM provider_auth_attempts');});

    test('exact schema and recorded-migration readiness reject missing provenance and drift',async()=>{
        const metadata=pool as unknown as MigrationConnection;
        await verifyAppleAndroidHandoffSchema(metadata);
        await assert.rejects(verifyAppleAndroidHandoffReadiness(metadata));
        await pool.query('CREATE TABLE schema_migrations (version VARCHAR(128) PRIMARY KEY)');
        try {
            await pool.query('INSERT INTO schema_migrations VALUES (?)',[APPLE_ANDROID_HANDOFF_MIGRATION]);
            await verifyAppleAndroidHandoffReadiness(metadata);
        } finally {await pool.query('DROP TABLE schema_migrations');}
        await pool.query('ALTER TABLE apple_android_handoffs DROP CHECK chk_apple_android_handoff_lifetime');
        try {
            await pool.query('ALTER TABLE apple_android_handoffs ADD CONSTRAINT chk_apple_android_handoff_lifetime CHECK (expires_at>created_at)');
            await assert.rejects(verifyAppleAndroidHandoffSchema(metadata));
        } finally {
            await pool.query('ALTER TABLE apple_android_handoffs DROP CHECK chk_apple_android_handoff_lifetime');
            await pool.query('ALTER TABLE apple_android_handoffs ADD CONSTRAINT chk_apple_android_handoff_lifetime CHECK (expires_at>created_at AND expires_at<=TIMESTAMPADD(SECOND,300,created_at))');
        }
        await verifyAppleAndroidHandoffSchema(metadata);
        await pool.query('ALTER TABLE apple_android_handoffs DROP CHECK chk_apple_android_handoff_client');
        try {
            await pool.query("ALTER TABLE apple_android_handoffs ADD CONSTRAINT chk_apple_android_handoff_client CHECK (BINARY client_key=BINARY 'apple- android')");
            await assert.rejects(verifyAppleAndroidHandoffSchema(metadata), 'literal whitespace is significant');
        } finally {
            await pool.query('ALTER TABLE apple_android_handoffs DROP CHECK chk_apple_android_handoff_client');
            await pool.query("ALTER TABLE apple_android_handoffs ADD CONSTRAINT chk_apple_android_handoff_client CHECK (BINARY client_key=BINARY 'apple-android')");
        }
        await verifyAppleAndroidHandoffSchema(metadata);
    });

    test('pending binding is read without credentials and callback is atomic/one-use',async()=>{
        const value=binding();
        assert.equal(await createHandoff(value),'created');
        assert.deepEqual(await store.readPending(value.stateHash),value);
        const results=await Promise.all(Array.from({length:8},()=>completeCallback(value,credential)));
        assert.equal(results.filter(Boolean).length,1);
        assert.equal(await store.readPending(value.stateHash),null);
        const [rows]=await pool.query<RowDataPacket[]>('SELECT encrypted_credential FROM apple_android_handoffs');
        assert.equal(rows[0].encrypted_credential.includes(Buffer.from(credential.authorizationCode)),false);
        assert.equal(await completeCallback(value,credential),null);
    });
    test('wrong binding/action/nonce/expiry cannot redeem; concurrent correct requests return once',async()=>{
        const value=binding(); await createHandoff(value); await completeCallback(value,credential);
        for(const change of [{bindingHash:randomBytes(32)},{action:'signup' as const},
            {nonce:randomBytes(32).toString('base64url')},{expiresAt:value.expiresAt-1}]) {
            assert.equal(await redeem({...value,...change}),null);
        }
        const results=await Promise.all(Array.from({length:8},()=>redeem(value)));
        assert.deepEqual(results.filter(result=>result!==null),[credential]);
        assert.equal(await count(),0);
        assert.equal(await redeem(value),null);
    });
    test('account targets are bound and a new begin invalidates the previous pending handoff',async()=>{
        const value={...binding(),action:'link' as const,accountId:'123e4567-e89b-42d3-a456-426614174000',userId:1};
        await createHandoff(value); await completeCallback(value,credential);
        assert.equal(await redeem({...value,userId:2}),null);
        const next={...value,stateHash:randomBytes(32),nonce:randomBytes(32).toString('base64url')};
        assert.equal(await createHandoff(next),'created');
        assert.equal(await redeem(value),null);
        assert.deepEqual(await store.readPending(next.stateHash),next);
    });
    test('tampered stored ciphertext is consumed before decryption error and never leaks payloads',async()=>{
        const value=binding(); await createHandoff(value); await completeCallback(value,credential);
        const bad=Buffer.from(cipher.encrypt(value,credential)); bad[bad.length-1]^=1;
        await pool.query('UPDATE apple_android_handoffs SET encrypted_credential=?',[bad]);
        await assert.rejects(redeem(value,createHash('sha256').update(bad).digest('base64url')),error=>error instanceof AppleAndroidHandoffError
            && !('cause' in error) && !error.message.includes(credential.authorizationCode));
        assert.equal(await count(),0);
    });
    test('database clock rejects expired/over-five-minute inserts',async()=>{
        const [clock]=await pool.query<RowDataPacket[]>("SELECT TIMESTAMPDIFF(MICROSECOND,'1970-01-01 00:00:00',UTC_TIMESTAMP(6)) DIV 1000 AS nowMs");
        const serverNow=Number(clock[0].nowMs);
        assert.equal(await createHandoff({...binding(),expiresAt:serverNow-60_000}),'busy');
        assert.equal(await createHandoff({...binding(),expiresAt:serverNow+310_000}),'busy');
        assert.equal(await count(),0);
    });
    test('expiry while a row lock is held cannot return credentials',async()=>{
        const value={...binding(),expiresAt:Date.now()+1500};
        await createHandoff(value); await completeCallback(value,credential);
        const locked=await pool.getConnection();
        await locked.beginTransaction();
        await locked.query('SELECT state_hash FROM apple_android_handoffs WHERE state_hash=? FOR UPDATE',[value.stateHash]);
        const result=redeem(value);
        try {await new Promise(resolve=>setTimeout(resolve,1800));} finally {await locked.commit();locked.release();}
        assert.equal(await result,null);
        assert.deepEqual(await store.cleanupExpired(),{deleted:1,backlog:false});
    });
    test('global cap is enforced across concurrent creators and same-binding replacement is bounded',async()=>{
        await fill(999);
        const results=await Promise.all(Array.from({length:8},()=>createHandoff(binding())));
        assert.equal(results.filter(result=>result==='created').length,1);
        assert.equal(await count(),1000);
        const [rows]=await pool.query<RowDataPacket[]>('SELECT binding_hash FROM apple_android_handoffs LIMIT 1');
        assert.equal(await createHandoff({...binding(),bindingHash:rows[0].binding_hash}),'created');
        assert.equal(await count(),1000);
    });
    test('physical cleanup has a fixed batch ceiling and reports backlog',async()=>{
        await fill(1001,true);
        assert.deepEqual(await store.cleanupExpired(),{deleted:1000,backlog:true});
        assert.deepEqual(await store.cleanupExpired(),{deleted:1,backlog:false});
    });
    test('redemption requires the original still-pending attempt and leaves that attempt for normal completion',async()=>{
        for(const mutation of ['missing','nonce','client','action','expiry']) {
            const value=binding(); await createHandoff(value); await completeCallback(value,credential);
            if(mutation==='missing') await pool.query('DELETE FROM provider_auth_attempts WHERE state_hash=?',[value.stateHash]);
            else if(mutation==='nonce') await pool.query('UPDATE provider_auth_attempts SET nonce=? WHERE state_hash=?',[randomBytes(32).toString('base64url'),value.stateHash]);
            else if(mutation==='client') await pool.query("UPDATE provider_auth_attempts SET client_key='apple-web' WHERE state_hash=?",[value.stateHash]);
            else if(mutation==='action') await pool.query("UPDATE provider_auth_attempts SET action='signup' WHERE state_hash=?",[value.stateHash]);
            else await pool.query('UPDATE provider_auth_attempts SET expires_at=UTC_TIMESTAMP(6) WHERE state_hash=?',[value.stateHash]);
            assert.equal(await redeem(value),null,mutation);
        }
        const value=binding(); await createHandoff(value); await completeCallback(value,credential);
        assert.deepEqual(await store.readAttempt(value.stateHash,value.bindingHash),value);
        assert.equal(await store.readAttempt(value.stateHash,randomBytes(32)),null);
        assert.deepEqual(await store.readReady(value.stateHash,value.bindingHash),value);
        assert.equal(await store.readReady(value.stateHash,randomBytes(32)),null);
        assert.deepEqual(await redeem(value),credential);
        const [rows]=await pool.query<RowDataPacket[]>('SELECT state_hash FROM provider_auth_attempts WHERE state_hash=?',[value.stateHash]);
        assert.equal(rows.length,1,'credential retrieval does not skip normal completion consumption');
    });
    test('callback cancellation is pending-only and cannot erase a ready credential',async()=>{
        const value=binding();await createHandoff(value);
        assert.equal(await store.cancelPending({...value,bindingHash:randomBytes(32)}),false);
        assert.equal(await store.cancelPending(value),true);
        assert.equal(await store.cancelPending(value),false);
        const next=binding();await createHandoff(next);await completeCallback(next,credential);
        assert.equal(await store.cancelPending(next),false);
        assert.deepEqual(await redeem(next),credential);
    });
    test('known state and native binding cannot poll redemption without the unpredictable verified-return proof',async()=>{
        const value=binding();await createHandoff(value);
        const proof=await completeCallback(value,credential);assert(proof);
        assert.match(proof,/^[A-Za-z0-9_-]{43}$/u);
        assert.equal(await store.redeem(value,''),null);
        assert.equal(await store.redeem(value,'A'.repeat(43)),null);
        assert.equal(await count(),1,'invalid proof must not consume a valid return');
        const other=binding();await createHandoff(other);const otherProof=await completeCallback(other,credential);assert(otherProof);
        assert.notEqual(proof,otherProof,'randomized envelopes produce independent return proofs');
        assert.equal(await store.redeem(value,otherProof),null);
        assert.deepEqual(await store.redeem(value,proof),credential);
        assert.equal(await store.redeem(value,proof),null);
    });
    test('attempt consumption/replacement and account deletion immediately cascade encrypted handoff removal',async()=>{
        const value=binding();await createHandoff(value);await completeCallback(value,credential);
        await pool.query('DELETE FROM provider_auth_attempts WHERE state_hash=?',[value.stateHash]);
        assert.equal(await count(),0);
        const previous=binding();await createHandoff(previous);await completeCallback(previous,credential);
        const replacement={...binding(),bindingHash:previous.bindingHash};await createHandoff(replacement);
        assert.equal(await store.readReady(previous.stateHash,previous.bindingHash),null);
        await pool.query('DELETE FROM provider_auth_attempts');
        const linked={...binding(),action:'link' as const,accountId:'123e4567-e89b-42d3-a456-426614174000',userId:1};
        await createHandoff(linked);await completeCallback(linked,credential);
        await pool.query('DELETE FROM users WHERE account_uuid=?',[linked.accountId]);
        try {assert.equal(await count(),0);} finally {await pool.query('INSERT INTO users VALUES (?)',[linked.accountId]);}
        const orphan=binding();assert.equal(await store.create(orphan),'busy');
        await assert.rejects(pool.query(`INSERT INTO apple_android_handoffs
            (state_hash,binding_hash,nonce,client_key,action,phase,created_at,expires_at)
            VALUES (?,?,?,'apple-android','login','pending',UTC_TIMESTAMP(6),TIMESTAMPADD(SECOND,240,UTC_TIMESTAMP(6)))`,
        [orphan.stateHash,orphan.bindingHash,orphan.nonce]));
        assert.equal(await count(),0,'DDL prevents handoff rows without their original attempt');
    });
    test('normal attempt consumption racing redemption uses parent-first locks without deadlock or credential replay',async()=>{
        for(let iteration=0;iteration<12;iteration++) {
            const value=binding();await createHandoff(value);const proof=await completeCallback(value,credential);assert(proof);
            const [redemption,consumption]=await Promise.all([
                store.redeem(value,proof),consumeProviderAttempt(pool,value.stateHash,value.bindingHash,'apple-android','login'),
            ]);
            assert.ok(consumption,'normal completion still owns the original attempt');
            assert.ok(redemption===null||redemption.idToken===credential.idToken);
            assert.equal(await store.redeem(value,proof),null);
            assert.equal(await count(),0);
        }
    });
    test('creation racing normal attempt replacement keeps parent-first locks and bounded global cleanup',async()=>{
        for(let iteration=0;iteration<12;iteration++) {
            const value=binding();await createHandoff(value);await fill(10,true);
            const next={...value,stateHash:randomBytes(32),nonce:randomBytes(32).toString('base64url')};
            const [creation,replacement]=await Promise.all([store.create(value),createProviderAttempt(pool,next)]);
            assert.ok(creation==='created'||creation==='busy');
            assert.equal(replacement,'created');
            assert.equal(await store.readPending(value.stateHash),null);
            assert.equal(await count(),0);
        }
    });
    test('maintenance cleanup and normal expired-parent creation share the parent creation lock',async()=>{
        for(let iteration=0;iteration<12;iteration++) {
            await fill(10,true);
            const [cleanup,creation]=await Promise.all([store.cleanupExpired(),createProviderAttempt(pool,binding())]);
            assert.equal(creation,'created');
            assert.ok(cleanup.deleted===0||cleanup.deleted===10);
            assert.equal(cleanup.backlog,false);
            assert.equal(await count(),0);
        }
    });
    test('DDL rejects invalid phase, nullable linked targets and overlong lifetime',async()=>{
        const value=binding(); await createHandoff(value);
        await assert.rejects(pool.query("UPDATE apple_android_handoffs SET phase='ready'"));
        await assert.rejects(pool.query("UPDATE apple_android_handoffs SET action='link',account_uuid='123e4567-e89b-42d3-a456-426614174000',user_id=NULL"));
        await assert.rejects(pool.query('UPDATE apple_android_handoffs SET expires_at=TIMESTAMPADD(SECOND,301,created_at)'));
        const [checks]=await pool.query<RowDataPacket[]>(`SELECT CONSTRAINT_NAME AS name,CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS
            WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME LIKE 'chk_apple_android_handoff_%' ORDER BY CONSTRAINT_NAME`);
        assert.equal(checks.length,4);
    });
}
