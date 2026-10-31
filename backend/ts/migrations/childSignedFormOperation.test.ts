import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fixture, settings, legacyCheck } from './childSignedFormMetadata.testFixture';
import { CHILD_SIGNED_FORM_SQL, CHILD_SIGNED_FORM_SQL_SHA256, childSignedFormFingerprint,
    assertChildSignedFormSql, assertChildReleaseSafety, planChildSignedFormOperation,
    applyChildSignedFormOperation, verifyChildSignedFormOperation,
    type ChildReleaseSafety, type ChildSignedFormOperationDependencies, type ChildSignedFormPlan } from './childSignedFormOperation';
import { migrationLockName } from './migrationRunner';
import { runtimeGrantLockName } from '../security/runtimeGrantOperations';
import { PRODUCTION_RUNTIME_DATABASE_ACCOUNT } from '../security/runtimeGrantManifest';

const source = { sourceCommit: 'a'.repeat(40), sqlSha256: CHILD_SIGNED_FORM_SQL_SHA256 };
const digest = (character: string) => character.repeat(64);
function safety(now: number): ChildReleaseSafety {
    const body = { schemaVersion: 1 as const, operation: 'child-schema-prerequisites' as const,
        sourceCommit: source.sourceCommit, sqlSha256: source.sqlSha256, target: settings.target,
        pinsSha256: digest('1'), serviceSha256: digest('2'), candidateSha256: digest('3'), fallbackSha256: digest('4'),
        readerSince: new Date(now - 300_001).toISOString(), readerVerifiedAt: new Date(now - 1).toISOString(), readerDurationMs: 300_000,
        automationSha256: digest('5'), backup: { id: '123', endTime: new Date(now - 60_000).toISOString(), sha256: digest('6') }, cloudSqlSha256: digest('7') };
    return { ...body, observedAt: new Date(now).toISOString(),
        pitr: { earliestRecoveryTime: new Date(now - 3_600_000).toISOString(), latestRecoveryTime: new Date(now - 10_000).toISOString() },
        stableSha256: childSignedFormFingerprint(body) };
}
function refreshStable(proof: ChildReleaseSafety): ChildReleaseSafety {
    const { observedAt: _at, pitr: _pitr, stableSha256: _sha, ...body } = proof;
    return { ...proof, stableSha256: childSignedFormFingerprint(body) };
}
function operationFixture(extended = false) {
    const f = fixture(extended);
    let now = Date.now(), destroyed = 0;
    const proof = safety(now);
    const calls: { sql: string; values?: unknown[] }[] = [];
    let action: ((sql: string) => Promise<void>) | undefined;
    const deps: ChildSignedFormOperationDependencies = { settings, source, now: () => now,
        observeReleaseSafety: async approved => ({ ...(approved?.releaseSafety ?? proof), observedAt: new Date(now).toISOString() }),
        connection: { destroy() { destroyed++; }, async query(sql, values) {
            calls.push({ sql, values });
            await action?.(sql);
            if (sql.startsWith('SET ')) return [[], []];
            if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
            if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
            if (sql === CHILD_SIGNED_FORM_SQL) {
                f.schema.nullable = 'YES'; f.schema.columns[3].nullable = 'YES';
                f.schema.check = legacyCheck.replace("(country_code='US')", "(country_codein('US','BR'))");
                return [[], []];
            }
            return f.connection.query(sql, values);
        } } };
    return { f, deps, proof, calls, now: () => now, advance: (ms: number) => { now += ms; },
        destroyed: () => destroyed, action: (next: (sql: string) => Promise<void>) => { action = next; } };
}
const approval = (plan: ChildSignedFormPlan) => ({ approvedPlanSha256: plan.sha256,
    confirmedServerUuid: settings.target.serverUuid, allowApply: true });
const noDdl = (calls: readonly { sql: string }[]) => assert(!calls.some(call => call.sql === CHILD_SIGNED_FORM_SQL));

test('pending SQL is the exact single reviewed literal and never enters the 26 migration history', () => {
    assertChildSignedFormSql(readFileSync(path.resolve(__dirname, '../../migrations/pending/0028_extend_child_signed_parent_forms.sql')));
    for (const sql of [CHILD_SIGNED_FORM_SQL.trimEnd(), CHILD_SIGNED_FORM_SQL.replace(/\n/gu, '\r\n'),
        `${CHILD_SIGNED_FORM_SQL}SELECT 1;`, CHILD_SIGNED_FORM_SQL.replace("'BR'", "'CA'")]) {
        assert.throws(() => assertChildSignedFormSql(Buffer.from(sql)), /blocked/u);
    }
});

test('plan watches before SQL and exact reviewed apply locks migrations and grants, issues one ALTER, verifies receipt', async () => {
    const f = operationFixture();
    let watched = false;
    const deps = { ...f.deps, observeReleaseSafety: async (plan?: ChildSignedFormPlan) => {
        if (!plan) { assert.equal(f.calls.length, 0); watched = true; }
        return f.deps.observeReleaseSafety(plan);
    } };
    const plan = await planChildSignedFormOperation(deps);
    assert(watched); assert.equal(plan.baseline.history.length, 26);
    assert.equal(plan.createdAt, new Date(f.now()).toISOString());
    const { sha256, ...body } = plan;
    assert.equal(sha256, childSignedFormFingerprint(body));
    f.calls.length = 0;
    const receipt = await applyChildSignedFormOperation(deps, JSON.parse(JSON.stringify(plan)), approval(plan));
    assert.equal(receipt.capability, 'nullable-parent-request-us-br'); assert.equal(receipt.sourceCommit, source.sourceCommit);
    assert.equal(receipt.grantsSha256, plan.baseline.grantsSha256);
    assert.equal(f.calls.filter(call => call.sql === CHILD_SIGNED_FORM_SQL).length, 1);
    assert.deepEqual(f.calls.filter(call => call.sql.includes('GET_LOCK')).map(call => call.values?.[0]), [
        migrationLockName(settings.target.database), runtimeGrantLockName(settings.target.database, PRODUCTION_RUNTIME_DATABASE_ACCOUNT)]);
    assert.deepEqual(f.calls.filter(call => call.sql.includes('RELEASE_LOCK')).map(call => call.values?.[0]), [
        runtimeGrantLockName(settings.target.database, PRODUCTION_RUNTIME_DATABASE_ACCOUNT), migrationLockName(settings.target.database)]);
    assert(!f.calls.some(call => /^(?:INSERT|DELETE|UPDATE|DROP)\b/u.test(call.sql)));
    assert.equal(f.destroyed(), 0);
    const verified = await verifyChildSignedFormOperation(deps);
    assert.equal(verified.schemaSha256, receipt.schemaSha256);
});

test('plan and verify reject inappropriate schema, exact history, target, runtime grants and untrusted source', async () => {
    for (const change of [
        (f: ReturnType<typeof operationFixture>) => { f.f.schema.nullable = 'YES'; },
        (f: ReturnType<typeof operationFixture>) => { f.f.history.pop(); },
        (f: ReturnType<typeof operationFixture>) => { f.f.history[0].checksum.fill(0); },
        (f: ReturnType<typeof operationFixture>) => { f.f.identity.serverUuid = 'wrong'; },
        (f: ReturnType<typeof operationFixture>) => { f.f.grants.global = [{ privilegeType: 'SELECT', isGrantable: 'NO' }]; },
    ]) {
        const f = operationFixture(); change(f);
        await assert.rejects(planChildSignedFormOperation(f.deps), /blocked/u); noDdl(f.calls);
    }
    await assert.rejects(planChildSignedFormOperation(operationFixture(true).deps), /blocked/u);
    await assert.rejects(verifyChildSignedFormOperation(operationFixture().deps), /blocked/u);
    const f = operationFixture();
    await assert.rejects(planChildSignedFormOperation({ ...f.deps, source: { ...source, sqlSha256: digest('0') } }), /blocked/u);
    await assert.rejects(planChildSignedFormOperation({ ...f.deps, assertSource: () => { throw new Error('dirty'); } }), /blocked/u);
    assert.equal(f.calls.length, 0);
});

test('prerequisites fail closed for missing/mixed source, target, drain, backup, recovery or fingerprint evidence', () => {
    const f = operationFixture();
    for (const change of [
        (p: any) => { delete p.automationSha256; },
        (p: any) => { p.unchecked = true; },
        (p: any) => { p.sourceCommit = 'b'.repeat(40); },
        (p: any) => { p.target.database = 'other'; },
        (p: any) => { p.readerDurationMs = 299_999; },
        (p: any) => { p.readerSince = p.readerVerifiedAt; },
        (p: any) => { p.backup.endTime = new Date(f.now() - 7_200_001).toISOString(); },
        (p: any) => { p.pitr.latestRecoveryTime = new Date(f.now() - 900_001).toISOString(); },
        (p: any) => { p.pitr.earliestRecoveryTime = new Date(f.now() + 1).toISOString(); },
        (p: any) => { p.observedAt = new Date(f.now() - 30_001).toISOString(); },
        (p: any) => { p.stableSha256 = digest('0'); },
    ]) {
        const proof = JSON.parse(JSON.stringify(f.proof)); change(proof);
        assert.throws(() => assertChildReleaseSafety(proof, f.deps, f.now()), /blocked/u);
    }
});

test('apply requires explicit exact digest/server/allow flag and unexpired reviewed plan, including all proof fields', async () => {
    const f = operationFixture(); const plan = await planChildSignedFormOperation(f.deps);
    f.calls.length = 0;
    for (const next of [{ ...approval(plan), allowApply: false }, { ...approval(plan), confirmedServerUuid: 'other' },
        { ...approval(plan), approvedPlanSha256: digest('0') }]) {
        await assert.rejects(applyChildSignedFormOperation(f.deps, plan, next), /blocked/u);
    }
    const tampered = JSON.parse(JSON.stringify(plan)); tampered.releaseSafety.readerDurationMs++;
    await assert.rejects(applyChildSignedFormOperation(f.deps, tampered, approval(plan)), /blocked/u);
    f.advance(300_001);
    await assert.rejects(applyChildSignedFormOperation(f.deps, plan, approval(plan)), /blocked/u);
    assert.equal(f.calls.length, 0);
});

test('apply rechecks under both locks and rejects changed schema/grants/cloud or lost recovery checkpoint', async () => {
    for (const drift of ['schema', 'grants', 'cloud', 'pitr']) {
        const f = operationFixture(); const plan = await planChildSignedFormOperation(f.deps);
        f.calls.length = 0;
        let reads = 0;
        const deps = { ...f.deps, observeReleaseSafety: async () => {
            if (++reads === 1) return f.proof;
            if (drift === 'schema') f.f.schema.columns[3].type = 'varchar(63)';
            if (drift === 'grants') f.f.grants.global = [{ privilegeType: 'SELECT', isGrantable: 'NO' }];
            if (drift === 'cloud') return refreshStable({ ...f.proof, candidateSha256: digest('9') });
            if (drift === 'pitr') return { ...f.proof, pitr: { ...f.proof.pitr, earliestRecoveryTime: new Date(f.now() - 9_000).toISOString() } };
            return f.proof;
        } };
        // SQL metadata drift must happen before its under-lock observation.
        if (drift === 'schema') f.f.schema.columns[3].type = 'varchar(63)';
        if (drift === 'grants') f.f.grants.global = [{ privilegeType: 'SELECT', isGrantable: 'NO' }];
        await assert.rejects(applyChildSignedFormOperation(deps, plan, approval(plan)), /blocked/u);
        noDdl(f.calls);
        assert.equal(f.calls.filter(call => call.sql.includes('RELEASE_LOCK')).length, 2);
    }
});

test('blocking cloud read that exhausts SQL deadline cannot dispatch DDL even before event-loop timers run', async () => {
    const f = operationFixture(); const plan = await planChildSignedFormOperation(f.deps);
    let reads = 0;
    await assert.rejects(applyChildSignedFormOperation({ ...f.deps, observeReleaseSafety: async () => {
        if (++reads === 2) f.advance(30_001);
        return { ...f.proof, observedAt: new Date(f.now()).toISOString() };
    } }, plan, approval(plan)), /blocked/u);
    noDdl(f.calls); assert(f.destroyed() > 0);
});

test('DDL failure is indeterminate, sanitized, physically discarded and never automatically retried', async () => {
    const f = operationFixture(); const plan = await planChildSignedFormOperation(f.deps);
    f.action(async sql => { if (sql === CHILD_SIGNED_FORM_SQL) throw new Error('private credentials and data'); });
    await assert.rejects(applyChildSignedFormOperation(f.deps, plan, approval(plan)), error =>
        error instanceof Error && /indeterminate/u.test(error.message) && !/private credentials/u.test(error.message));
    assert.equal(f.calls.filter(call => call.sql === CHILD_SIGNED_FORM_SQL).length, 1);
    assert.equal(f.calls.filter(call => call.sql.includes('RELEASE_LOCK')).length, 0);
    assert(f.destroyed() > 0);
});

test('source drift after a successful ALTER withholds the source-bound receipt and requires independent verification', async () => {
    const f = operationFixture(); const plan = await planChildSignedFormOperation(f.deps);
    let altered = false;
    f.action(async sql => { if (sql === CHILD_SIGNED_FORM_SQL) altered = true; });
    await assert.rejects(applyChildSignedFormOperation({ ...f.deps, assertSource() {
        if (altered) throw new Error('source changed during DDL');
    } }, plan, approval(plan)), /indeterminate/u);
    assert.equal(f.calls.filter(call => call.sql === CHILD_SIGNED_FORM_SQL).length, 1);
    assert(f.destroyed() > 0);
});

for (const hangAt of ['GET_LOCK', CHILD_SIGNED_FORM_SQL, 'RELEASE_LOCK']) test(`timeout at ${hangAt.slice(0, 20)} prevents any later queued queries`, async () => {
    const f = operationFixture(); const plan = await planChildSignedFormOperation(f.deps);
    let resume!: () => void;
    const pending = new Promise<void>(resolve => { resume = resolve; });
    let hung = false;
    f.action(async sql => { if (!hung && sql.includes(hangAt)) { hung = true; await pending; } });
    await assert.rejects(applyChildSignedFormOperation({ ...f.deps, operationTimeoutMs: 1_000 }, plan, approval(plan)),
        hangAt === 'GET_LOCK' ? /blocked/u : /indeterminate/u);
    const count = f.calls.length;
    resume(); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.calls.length, count); assert(f.destroyed() > 0);
    if (hangAt === 'GET_LOCK') noDdl(f.calls);
});
