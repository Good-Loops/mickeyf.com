import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, now as fixtureNow } from './test-support/provider-release-fixture.mjs';
import { PROJECT, REGION, SERVICE, fingerprint, sessionRevisionName } from './frozen-backend-traffic.mjs';
import { PROVIDER_FIXED_ENV } from './provider-release-config.mjs';
import { rollbackRevisionName } from './session-backend-traffic.mjs';
import { CHILD_SIGNED_FORM_SQL_SHA256, createChildSchemaVerifier, childSchemaVerificationEnvironment,
    createChildMigrationPrerequisiteReader, validateChildMigrationPrerequisiteProof } from './child-schema-verifier.mjs';

const source = 'a'.repeat(40), uuid = PROVIDER_FIXED_ENV.APPLE_MAINTENANCE_EXPECTED_SERVER_UUID;
function receipt() {
    return { schemaVersion: 1, operation: 'verify-child-signed-form-schema', verifiedAt: new Date(fixtureNow).toISOString(),
        sourceCommit: source, sqlSha256: CHILD_SIGNED_FORM_SQL_SHA256,
        target: { project: PROJECT, instance: 'cms-mickeyf', database: 'cms', serverUuid: uuid },
        capability: 'nullable-parent-request-us-br', runtimeGrantProfile: 'google-apple-parent-signed',
        schemaSha256: 'b'.repeat(64), grantsSha256: 'c'.repeat(64) };
}
function privateEnvironment() {
    return { PATH: '/synthetic/bin', SystemRoot: 'C:\\Windows', MIGRATION_DB_HOST: '127.0.0.1', MIGRATION_DB_PORT: '3311',
        MIGRATION_DB_USER: 'synthetic-admin', MIGRATION_DB_PASS: 'synthetic-private-value', MIGRATION_DB_NAME: 'cms',
        MIGRATION_CONFIRM_DATABASE: 'cms', MIGRATION_CONFIRM_TARGET: '127.0.0.1:3311/cms', MIGRATION_CONFIRM_ACCOUNT: 'synthetic-admin@%',
        MIGRATION_CONFIRM_SERVER_UUID: uuid, MIGRATION_CONFIRM_CLOUD_SQL_PROJECT: PROJECT, MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE: 'cms-mickeyf',
        MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME: `${PROJECT}:${REGION}:cms-mickeyf`,
        MIGRATION_CONFIRM_SERVER_VERSION: '8.0.synthetic', MIGRATION_CONFIRM_VERSION_COMMENT: 'Synthetic test only' };
}

test('real SQL adapter executes only the fixed verify command in backend with isolated private environment', async () => {
    const extra = { NODE_OPTIONS: '--require malicious', NODE_PATH: '/malicious', DB_PASS: 'runtime-secret',
        GOOGLE_APPLICATION_CREDENTIALS: '/private/cloud.json', MIGRATION_ALLOW_APPLY: '1', MIGRATION_DB_SOCKET: '/wrong/socket',
        TS_NODE_PROJECT: '/wrong/project', CHILD_SIGNED_FORM_SOURCE_COMMIT: 'f'.repeat(40) };
    let time = fixtureNow, called = false;
    const verify = createChildSchemaVerifier({ environment: () => ({ ...privateEnvironment(), ...extra }), now: () => time,
        run: async (file, args, options) => {
            called = true;
            assert.equal(file, process.execPath);
            assert.deepEqual(args, ['-r', 'ts-node/register', 'ts/migrations/runChildSignedFormSchema.ts', 'verify']);
            assert.match(options.cwd.replaceAll('\\', '/'), /\/backend\/$/);
            assert.equal(options.shell, false); assert.equal(options.timeout, 60_000); assert.equal(options.maxBuffer, 32_768);
            assert.equal(options.env.MIGRATION_DB_PASS, 'synthetic-private-value');
            assert.equal(options.env.CHILD_SIGNED_FORM_SOURCE_COMMIT, source);
            for (const key of Object.keys(extra).filter(key => key !== 'CHILD_SIGNED_FORM_SOURCE_COMMIT')) assert.equal(options.env[key], undefined);
            time += 6000; // A real asynchronous verifier can take longer than the allowed future skew.
            return { status: 0, stdout: JSON.stringify({ ...receipt(), verifiedAt: new Date(time).toISOString() }) };
        } });
    assert.equal((await verify(receipt())).verifiedAt, new Date(time).toISOString());
    assert.equal(called, true);
});

test('SQL adapter refuses missing/foreign configuration and never logs private subprocess failure output', async () => {
    let calls = 0;
    for (const environment of [{}, { ...privateEnvironment(), MIGRATION_DB_HOST: 'prod.example' },
        { ...privateEnvironment(), MIGRATION_CONFIRM_SERVER_UUID: 'wrong' }]) {
        const verify = createChildSchemaVerifier({ environment: () => environment, now: () => fixtureNow, run: () => { calls++; } });
        await assert.rejects(verify(receipt()), /not configured|target confirmations/);
    }
    assert.equal(calls, 0);
    for (const result of [{ status: 1, stdout: 'synthetic-private-value', stderr: 'synthetic-private-value' },
        { status: null, error: new Error('synthetic-private-value') }, { status: 0, stdout: '{synthetic-private-value' }]) {
        const verify = createChildSchemaVerifier({ environment: privateEnvironment, now: () => fixtureNow, run: () => result });
        await assert.rejects(verify(receipt()), error => /private process output was not logged/.test(error.message)
            && !error.message.includes('synthetic-private-value'));
    }
});

test('SQL adapter rejects changed receipt identity, exact keys, SQL, schema, grants and timestamps', async () => {
    const changes = [r => { r.extra = true; }, r => { r.target.extra = true; }, r => { r.target.database = 'other'; },
        r => { r.sourceCommit = 'd'.repeat(40); }, r => { r.sqlSha256 = 'd'.repeat(64); }, r => { r.schemaSha256 = 'd'.repeat(64); },
        r => { r.grantsSha256 = 'd'.repeat(64); }, r => { r.capability = 'legacy'; }, r => { r.runtimeGrantProfile = 'google'; },
        r => { r.verifiedAt = new Date(fixtureNow - 300_001).toISOString(); }, r => { r.verifiedAt = new Date(fixtureNow + 5001).toISOString(); }];
    for (const change of changes) {
        const observed = receipt(); change(observed);
        const verify = createChildSchemaVerifier({ environment: privateEnvironment, now: () => fixtureNow,
            run: () => ({ status: 0, stdout: JSON.stringify(observed) }) });
        await assert.rejects(verify(receipt()), /unexpected fields|differs|stale|changed/);
    }
    assert.equal(childSchemaVerificationEnvironment(privateEnvironment(), source).MIGRATION_ALLOW_APPLY, undefined);
});

function cloudFixture() {
    const f = fixture('prepare-child'), clock = { now: fixtureNow, elapsed: 0, sleeps: [], fetches: [] };
    const candidate = sessionRevisionName(f.pins.candidate.deployment);
    const fallback = rollbackRevisionName(f.pins);
    const runtime = ['containers', 'serviceAccount', 'maxInstanceRequestConcurrency', 'timeout', 'scaling', 'volumes'];
    f.service.template = { revision: candidate, ...Object.fromEntries(runtime.map(key => [key, structuredClone(f.candidate[key])])) };
    f.service.latestCreatedRevision = f.service.latestReadyRevision = `${SERVICE}/revisions/${candidate}`;
    f.service.traffic = [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: candidate, percent: 100 }];
    f.service.trafficStatuses = structuredClone(f.service.traffic);
    const triggers = ['9fbd63bf-d129-4877-bb26-26d38e1ca468', '181b8f84-2303-4c2b-a03e-92dae4b1938c',
        '1c9c6502-f53f-4e04-ac9e-06bf49668acf', '648fadca-3cd1-4b57-9d35-0f62a1468443',
        'd71109da-8350-4f2f-a3be-2053bb6ccd45', 'ef5a2981-95be-4f4d-af91-f997fde73356'].map(id => ({ id, disabled: true }));
    const instance = { name: 'cms-mickeyf', project: PROJECT, region: REGION, connectionName: `${PROJECT}:${REGION}:cms-mickeyf`,
        databaseVersion: 'MYSQL_8_0_31', state: 'RUNNABLE', settings: { settingsVersion: '1', deletionProtectionEnabled: true,
            availabilityType: 'REGIONAL', backupConfiguration: { enabled: true, binaryLogEnabled: true,
                transactionLogRetentionDays: 7, transactionalLogStorageState: 'CLOUD_STORAGE' } } };
    const backups = [{ id: '12345', instance: 'cms-mickeyf', status: 'SUCCESSFUL', endTime: new Date(fixtureNow - 60_000).toISOString() }];
    const operations = [{ targetId: 'cms-mickeyf', targetProject: PROJECT, status: 'DONE' }];
    const revisions = { [candidate]: f.candidate, [fallback]: f.rollback, [f.pins.baseline.revisionName]: f.baseline };
    const state = { ...f, clock, triggers, regionalTriggers: [], activeBuilds: [], instance, backups, operations,
        recovery: () => ({ earliestRecoveryTime: new Date(clock.now - 7 * 86_400_000).toISOString(), latestRecoveryTime: new Date(clock.now - 10_000).toISOString() }) };
    const fetcher = async (url, options) => {
        assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
        assert.equal(options.body, undefined);
        clock.fetches.push(url);
        const target = new URL(url), path = target.pathname;
        let body;
        if (target.hostname === 'run.googleapis.com') body = path.endsWith('/services/mickeyf-org') ? f.service : revisions[path.split('/').at(-1)];
        else if (target.hostname === 'cloudbuild.googleapis.com') {
            if (path.endsWith('/triggers')) body = { triggers: path.includes('/global/') ? triggers : state.regionalTriggers };
            else if (path.endsWith('/builds')) body = { builds: state.activeBuilds };
            else body = f.build;
        } else if (path.endsWith('/backupRuns')) body = { kind: 'sql#backupRunsList', items: backups };
        else if (path.endsWith('/getLatestRecoveryTime')) body = state.recovery();
        else if (path.endsWith('/operations')) body = { items: operations };
        else body = instance;
        assert.ok(body, `Unexpected synthetic metadata request ${path}`);
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    state.reader = createChildMigrationPrerequisiteReader('synthetic-token-with-sufficient-length', fetcher, {
        now: () => clock.now, monotonic: () => clock.elapsed, sleep: async ms => {
            clock.sleeps.push(ms); clock.now += ms; clock.elapsed += ms;
            state.onSleep?.();
        },
    });
    return state;
}
function approvedPlan(proof, now) {
    const plan = { schemaVersion: 1, operation: 'extend-child-signed-form-schema', createdAt: new Date(now).toISOString(),
        sourceCommit: proof.sourceCommit, sqlSha256: proof.sqlSha256, target: structuredClone(proof.target),
        baseline: { identity: { databaseName: 'cms', currentUser: 'synthetic-admin@%', serverUuid: uuid,
            serverVersion: '8.0.31', versionComment: 'Synthetic test only' },
            history: Array.from({ length: 26 }, (_, i) => ({ version: `${String(i + 1).padStart(4, '0')}_synthetic`, checksumSha256: 'a'.repeat(64) })),
            capability: 'legacy-us', schemaSha256: 'b'.repeat(64), grantsSha256: 'c'.repeat(64) }, releaseSafety: proof };
    plan.sha256 = fingerprint(plan);
    return plan;
}

test('authenticated metadata reader watches actual monotonic duration and binds new-only closed source/runtime/recovery', async () => {
    const f = cloudFixture();
    const proof = await f.reader.read(f.pins);
    assert.equal(proof.readerDurationMs, 300_000);
    assert.deepEqual(f.clock.sleeps, Array(6).fill(50_000));
    assert.equal(Date.parse(proof.readerVerifiedAt) - Date.parse(proof.readerSince), 300_000);
    assert.equal(proof.sourceCommit, f.pins.candidate.deployment.sourceCommit);
    assert.equal(proof.pinsSha256, fingerprint(f.pins));
    assert.equal(proof.backup.id, '12345');
    assert.equal(validateChildMigrationPrerequisiteProof(proof, f.pins, f.clock.now), proof);
    const plan = approvedPlan(proof, f.clock.now);
    f.clock.now += 1000;
    const refreshed = await f.reader.read(f.pins, { approvedPlan: plan, confirmation: plan.sha256 });
    assert.equal(f.clock.sleeps.length, 6, 'approved-plan recheck never repeats or fabricates the drain wait');
    assert.equal(refreshed.stableSha256, proof.stableSha256);
    assert.notEqual(refreshed.pitr.latestRecoveryTime, proof.pitr.latestRecoveryTime);
});

test('reader rejects general/active/old-source pins before any cloud call', async () => {
    for (const phase of ['prepare', 'active']) {
        const f = cloudFixture(), other = fixture(phase);
        await assert.rejects(f.reader.read(other.pins), /creation-closed child binary/);
        assert.equal(f.clock.fetches.length, 0);
    }
});

test('reader emits canonical conservative millisecond recovery timestamps and integer monotonic duration', async () => {
    const f = cloudFixture();
    f.backups[0].endTime = new Date(fixtureNow - 60_000).toISOString().replace('.000Z', '.000123456Z');
    f.recovery = () => ({ earliestRecoveryTime: new Date(fixtureNow - 86_400_000).toISOString().replace('.000Z', '.000123456Z'),
        latestRecoveryTime: new Date(f.clock.now - 10_000).toISOString().replace('.000Z', '.000987654Z') });
    f.onSleep = () => { f.clock.elapsed += 0.125; f.clock.now += 0.125; };
    const proof = await f.reader.read(f.pins);
    assert.ok(Number.isSafeInteger(proof.readerDurationMs));
    assert.ok(proof.readerDurationMs >= 300_000);
    assert.equal(proof.backup.endTime, new Date(fixtureNow - 60_000 + 1).toISOString());
    assert.equal(proof.pitr.earliestRecoveryTime, new Date(fixtureNow - 86_400_000 + 1).toISOString());
    assert.equal(proof.pitr.latestRecoveryTime, new Date(f.clock.now - 10_000).toISOString());
    for (const timestamp of [proof.backup.endTime, proof.pitr.earliestRecoveryTime, proof.pitr.latestRecoveryTime]) {
        assert.equal(new Date(timestamp).toISOString(), timestamp);
    }
    // Execute the actual TypeScript core proof parser; no database or cloud dependency is invoked.
    execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', `
        const { readFileSync } = require('node:fs');
        const { assertChildReleaseSafety } = require('./ts/migrations/childSignedFormOperation');
        const { proof, now } = JSON.parse(readFileSync(0, 'utf8'));
        assertChildReleaseSafety(proof, { settings: { target: proof.target },
            source: { sourceCommit: proof.sourceCommit, sqlSha256: proof.sqlSha256 } }, now);
    `], { cwd: fileURLToPath(new URL('../backend/', import.meta.url)), shell: false, windowsHide: true,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].includes(key.toUpperCase()))),
        input: JSON.stringify({ proof, now: f.clock.now }), timeout: 30_000, maxBuffer: 32_768, stdio: ['pipe', 'pipe', 'pipe'] });
});

test('reader rejects traffic, ready, fallback/source drift and changes during the actual watch', async () => {
    const changes = [f => { f.service.traffic[0].revision = f.pins.baseline.revisionName; },
        f => { f.service.traffic[0].tag = 'unreviewed'; }, f => { f.service.reconciling = true; },
        f => { f.rollback.containers[0].image = 'unreviewed'; }, f => { f.rollback.labels['source-commit'] = 'd'.repeat(40); },
        f => { f.onSleep = () => { f.service.generation = f.service.observedGeneration = '999'; }; }];
    for (const change of changes) {
        const f = cloudFixture(); change(f);
        await assert.rejects(f.reader.read(f.pins), /resolved|candidate|Ready|image|source|configuration|during/);
    }
});

test('reader rejects incomplete/enabled automation, ongoing operations and stale/disabled recovery', async () => {
    const changes = [f => { f.triggers.pop(); }, f => { f.triggers[0].disabled = false; },
        f => { f.regionalTriggers.push({ id: 'unexpected', disabled: true }); }, f => { f.activeBuilds.push({ status: 'WORKING' }); },
        f => { f.operations[0].status = 'RUNNING'; }, f => { f.instance.settings.backupConfiguration.binaryLogEnabled = false; },
        f => { f.backups[0].status = 'FAILED'; }, f => { f.backups[0].endTime = new Date(fixtureNow - 7_200_001).toISOString(); },
        f => { f.recovery = () => ({ earliestRecoveryTime: new Date(fixtureNow - 86_400_000).toISOString(),
            latestRecoveryTime: new Date(f.clock.now - 900_001).toISOString() }); }];
    for (const change of changes) {
        const f = cloudFixture(); change(f);
        await assert.rejects(f.reader.read(f.pins), /triggers|builds|operations|protection|backup|PITR/);
    }
});

test('only a fresh entire approved plan can reuse the bound watch; material drift or lost checkpoint rejects', async () => {
    const f = cloudFixture(), proof = await f.reader.read(f.pins), plan = approvedPlan(proof, f.clock.now);
    await assert.rejects(f.reader.read(f.pins, { approvedPlan: { ...plan, createdAt: new Date(f.clock.now + 1).toISOString() }, confirmation: plan.sha256 }), /operator-approved/);
    await assert.rejects(f.reader.read(f.pins, { confirmation: plan.sha256 }), /standalone/);
    for (const alter of [p => { delete p.baseline; }, p => { p.sourceCommit = 'f'.repeat(40); }, p => { p.target.database = 'other'; },
        p => { p.baseline.history.pop(); }, p => { p.baseline.identity.serverUuid = 'wrong'; }, p => { p.createdAt = proof.readerSince; }]) {
        const changed = structuredClone(plan); alter(changed);
        const { sha256: _old, ...body } = changed; changed.sha256 = fingerprint(body);
        await assert.rejects(f.reader.read(f.pins, { approvedPlan: changed, confirmation: changed.sha256 }), /Approved|operator-approved|predates/);
    }
    f.instance.settings.settingsVersion = '2';
    await assert.rejects(f.reader.read(f.pins, { approvedPlan: plan, confirmation: plan.sha256 }), /fingerprints changed/);
    f.instance.settings.settingsVersion = '1';
    f.recovery = () => ({ earliestRecoveryTime: new Date(f.clock.now - 1000).toISOString(), latestRecoveryTime: new Date(f.clock.now).toISOString() });
    await assert.rejects(f.reader.read(f.pins, { approvedPlan: plan, confirmation: plan.sha256 }), /PITR|checkpoint/);
    assert.equal(f.clock.sleeps.length, 6);
});

test('activation cloud adapter defaults to the real SQL verifier and CLI never imports a fixture or fake verifier', async () => {
    const activation = await readFile(new URL('./provider-backend-activation.mjs', import.meta.url), 'utf8');
    const cli = await readFile(new URL('./provider-backend-release.mjs', import.meta.url), 'utf8');
    assert.match(activation, /verifyChildSchema = createChildSchemaVerifier\(\)/);
    assert.match(activation, /validateChildSchemaReceipt\(observed, pins, clock\(\)\)/);
    assert.match(activation, /freshChildSchema\(pins, clock\(\)\)/);
    assert.doesNotMatch(cli, /test-support|verifyChildSchema:\s*async/);
});
