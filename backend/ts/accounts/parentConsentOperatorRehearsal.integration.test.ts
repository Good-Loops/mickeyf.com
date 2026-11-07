import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import mysql, { type Connection, type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { createAccountSession, readLiveSession } from '../auth/accountSessionRepository';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import type { VerifiedProviderIdentity } from '../auth/providerIdentity';
import { loadMigrationConfig } from '../config/migrationConfig';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { loadMigrationManifest } from '../migrations/migrationManifest';
import { applyMigrations } from '../migrations/migrationRunner';
import { verifySignedParentFormReadiness } from '../migrations/signedParentFormSchema';
import { renderRuntimeGrantStatements } from '../security/runtimeGrantManifest';
import { createParentRegistrationFlow, type ParentRegistrationPolicy } from './parentRegistrationFlow';
import { createParentRegistrationRepository } from './parentRegistrationRepository';
import { cleanupSignedParentForms } from './signedParentFormReview';
import { recordParentFormAppleRelayEvent, verifyParentFormAppleRelayWriteAccess } from './parentFormAppleRelayState';
import type { VerifiedAppleNotification } from '../auth/appleNotificationVerifier';
import { applyAppleNotification } from '../auth/appleSessionRevocation';
import type { SignedParentFormRequest } from './signedParentForm';

const label = 'SYNTHETIC TEST ONLY - NOT VALID CONSENT';
const config = loadMigrationConfig();
const backendDirectory = path.resolve(__dirname, '../..');
const temporaryRoot = realpathSync(tmpdir());
let directory: string | undefined;
let admin: Connection;
let database: Pool;
let serverUuid: string;
let parentPasswordHash: string;
const deletionIntents: string[] = [];
const policy: ParentRegistrationPolicy = { audience: 'children-included', countries: ['BR', 'US'],
    signedFormCountries: ['BR', 'US'], creationEnabled: true, signedFormsEnabled: true,
    version: 'synthetic-operator-parent-v1', consentVersion: 'synthetic-not-valid-consent-v1',
    consentText: label, privacyNoticeUrl: 'https://notice.example.test/synthetic-only' };

// The fixed SQL is executed only after exact source comparison and disposable-target checks.
const childSchema = `ALTER TABLE parent_signed_forms
    MODIFY COLUMN user_name VARCHAR(64) NULL,
    DROP CHECK chk_signed_form_status,
    ADD CONSTRAINT chk_signed_form_status CHECK (
        country_code IN ('US','BR') AND public_approved IN (0,1) AND public_withdrawn IN (0,1)
        AND (public_approved = 0 OR public_policy_digest IS NOT NULL)
        AND ((status = 'pending' AND reviewed_at IS NULL AND reviewer IS NULL AND form_sha256 IS NULL AND child_uuid IS NULL AND public_approved = 0)
          OR (status IN ('approved','rejected') AND reviewed_at IS NOT NULL AND reviewer IS NOT NULL AND form_sha256 IS NOT NULL AND child_uuid IS NULL)
          OR (status = 'used' AND reviewed_at IS NOT NULL AND reviewer IS NOT NULL AND form_sha256 IS NOT NULL AND child_uuid IS NOT NULL))
    );`;

before(async () => {
    assert.equal(process.env.SYNTHETIC_PARENT_CONSENT_REHEARSAL, '1');
    assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.MIGRATION_TEST_ENABLED, '1');
    assert.match(process.env.SYNTHETIC_REHEARSAL_CONTAINER ?? '', /^[a-f0-9]{64}$/u);
    assert.equal(config.host, '127.0.0.1'); assert.equal(config.database, 'mickeyf_migration_test');
    assert.equal(config.user, 'migration_test'); assert.equal(config.password, 'migration-test-only');
    assert.equal(config.port, Number(process.env.MIGRATION_TEST_PORT)); assert.notEqual(config.port, 3306);
    for (const key of ['DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CLOUD_SQL_CONNECTION_NAME',
        'GOOGLE_APPLICATION_CREDENTIALS', 'SIGNED_FORM_CONFIRM_SERVER_UUID']) assert.equal(process.env[key], undefined);
    assert.equal(process.env.MIGRATION_TEST_ROOT_PASSWORD, 'migration-test-root-only');
    admin = await mysql.createConnection({ host: config.host, port: config.port, database: config.database, user: 'root',
        password: 'migration-test-root-only', multipleStatements: false, dateStrings: true, timezone: 'Z' });
    const [[target]] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db, @@version AS version, @@version_comment AS vendor, @@server_uuid AS serverUuid');
    assert.equal(target.db, config.database); assert.match(target.version, /^8\.0\.31(?:-|$)/u); assert.doesNotMatch(target.vendor, /Google/iu);
    const [tables] = await admin.query<RowDataPacket[]>('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    assert.equal(tables.length, 0, 'a rehearsal must start in a fresh disposable database; it never drops existing tables');
    serverUuid = target.serverUuid;
    directory = realpathSync(mkdtempSync(path.join(temporaryRoot, 'ludolume-synthetic-parent-consent-')));
    assert.equal(path.dirname(directory), temporaryRoot);
    await admin.query(`CREATE TABLE users (user_id INT NOT NULL AUTO_INCREMENT, user_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL, user_password VARCHAR(255) NOT NULL, PRIMARY KEY (user_id), UNIQUE KEY uq_users_email (email))
        ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const migrations = loadMigrationManifest();
    for (const allowedEffectKinds of [['create-table'] as const, ['drop-column'] as const,
        [...new Set(migrations.filter(migration => migration.version > '0003').map(migration => migration.effect))]]) {
        await applyMigrations(admin as unknown as MigrationConnection, migrations, config, { allowedEffectKinds });
    }
    const migrationSource = readFileSync(path.join(backendDirectory, 'migrations/pending/0028_extend_child_signed_parent_forms.sql'), 'utf8');
    assert.equal(migrationSource.replace(/\r\n/gu, '\n').trim(), childSchema);
    await admin.query(childSchema);
    await admin.query(readFileSync(path.join(backendDirectory, 'migrations/pending/draft_parent_form_apple_relay_state.sql'), 'utf8'));
    await admin.query("CREATE USER 'parent_rehearsal_runtime'@'%' IDENTIFIED BY 'synthetic-runtime-only'");
    for (const sql of renderRuntimeGrantStatements(config.database, { user: 'parent_rehearsal_runtime', host: '%' }, 'google-apple-parent-signed')) await admin.query(sql);
    await admin.query("GRANT SELECT,INSERT,UPDATE,DELETE ON mickeyf_migration_test.parent_form_apple_relay_state TO 'parent_rehearsal_runtime'@'%'");
    await admin.query("CREATE USER 'parent_rehearsal_operator'@'%' IDENTIFIED BY 'synthetic-operator-only'");
    await admin.query("GRANT SELECT ON mickeyf_migration_test.schema_migrations TO 'parent_rehearsal_operator'@'%'");
    await admin.query("GRANT SELECT ON mickeyf_migration_test.parent_signed_forms TO 'parent_rehearsal_operator'@'%'");
    await admin.query("GRANT SELECT ON mickeyf_migration_test.parent_form_apple_relay_state TO 'parent_rehearsal_operator'@'%'");
    await admin.query("GRANT SELECT (account_uuid,provider,subject) ON mickeyf_migration_test.account_provider_identities TO 'parent_rehearsal_operator'@'%'");
    await admin.query("GRANT UPDATE (status,reviewed_at,reviewer,form_sha256,public_approved) ON mickeyf_migration_test.parent_signed_forms TO 'parent_rehearsal_operator'@'%'");
    database = mysql.createPool({ host: config.host, port: config.port, database: config.database, user: 'parent_rehearsal_runtime',
        password: 'synthetic-runtime-only', multipleStatements: false, connectionLimit: 4, dateStrings: true, timezone: 'Z' });
    await verifySignedParentFormReadiness(database as unknown as MigrationConnection, true);
    parentPasswordHash = await bcrypt.hash('synthetic-parent-password-not-a-real-account', 4);
});

after(async () => {
    if (database) await database.end();
    if (admin) await admin.end();
    if (directory) {
        const owned = realpathSync(directory);
        assert.equal(path.dirname(owned), temporaryRoot);
        assert(path.basename(owned).startsWith('ludolume-synthetic-parent-consent-'));
        rmSync(owned, { recursive: true, force: true });
    }
});

async function parent(country: string, provider: 'google' | 'apple' = 'google') {
    const accountId = randomUUID();
    const name = `synthetic-parent-${country}-${randomUUID()}`;
    const contact = `${name.toLowerCase()}@${provider === 'apple' ? 'privaterelay.appleid.com' : 'example.test'}`;
    const [insert] = await admin.query<ResultSetHeader>('INSERT INTO users (user_name,email,user_password,account_uuid) VALUES (?,?,?,?)',
        [name, contact, parentPasswordHash, accountId]);
    const account = { userId: insert.insertId, accountId };
    const identity = { provider, subject: name, email: contact } as VerifiedProviderIdentity;
    await admin.query('INSERT INTO account_provider_identities (provider,subject,account_uuid,linked_at) VALUES (?,?,?,UTC_TIMESTAMP(6))',
        [provider, Buffer.from(name, 'ascii'), accountId]);
    const sessionId = randomBytes(32).toString('base64url');
    assert(await createAccountSession(database, account, sessionId, Math.floor(Date.now() / 1000) + 1800, parentPasswordHash));
    const context = { account, session: { accountId, sessionId }, bindingHash: randomBytes(32),
        bindingExpiresAt: null, anonymousCookie: null } as ProviderAuthContext;
    const store = createParentRegistrationRepository(database, { async recordAccountDeletion(id) { deletionIntents.push(id); } },
        undefined, true, { countries: ['BR', 'US'], credentialsAfterApproval: true });
    const clientKey = `${provider}-web`;
    const flow = createParentRegistrationFlow({ store, policy, clients: { [clientKey]: { provider, verifier: {
        async verify() { return { verified: true, identity }; },
    } } } });
    const request = { purpose: 'create-child', country, clientKey, policyVersion: policy.version,
        consentVersion: policy.consentVersion, privacyNoticeUrl: policy.privacyNoticeUrl,
        adultAttestation: true, guardianAttestation: true, consent: true };
    async function requestForm() {
        const challenge = await flow.begin(context, request); assert.ok('state' in challenge, JSON.stringify(challenge));
        const result = await flow.requestSignedForm(context, { state: challenge.state, idToken: 'SYNTHETIC-NO-PROVIDER-REQUEST' });
        assert.ok('form' in result, JSON.stringify(result)); assert.equal(result.form.userName, null);
        return result.form;
    }
    async function proof(input: unknown = request) {
        const challenge = await flow.begin(context, input); assert.ok('state' in challenge, JSON.stringify(challenge));
        const result = await flow.complete(context, { state: challenge.state, idToken: 'SYNTHETIC-NO-PROVIDER-REQUEST' });
        assert.ok('grant' in result, JSON.stringify(result)); return result.grant;
    }
    return { account, contact, context, flow, request, requestForm, proof, identity, subject: name };
}

async function formRow(reference: string) {
    const [[row]] = await admin.query<RowDataPacket[]>('SELECT status,user_name,policy_digest,form_sha256,reviewer,public_approved FROM parent_signed_forms WHERE reference=?', [reference]);
    return row;
}

async function operator(command: 'inspect' | 'approve' | 'reject', form: SignedParentFormRequest, decisionSucceeds = true,
    confirmedServerUuid = serverUuid, relayStateEnabled = false) {
    const file = path.join(directory!, `${form.reference}.SYNTHETIC-NOT-VALID-CONSENT.txt`);
    const contents = `${label}\nNo human signed this file. No consent or guardian identity is verified.\nRequest: ${form.reference}\nCountry: ${form.country}\n`;
    if (command !== 'inspect') writeFileSync(file, contents, { flag: 'w' });
    const current = await formRow(form.reference);
    const options = command === 'inspect' ? [] : [`--parent-account=${form.parentAccountId}`, `--contact=${form.verifiedContact}`,
        `--policy-digest=${current.policy_digest.toString('hex')}`, `--form-file=${file}`, `--reviewer=${label}`,
        '--public-permission=false', '--signed-parent-reviewed=true'];
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register', 'ts/accounts/runSignedParentFormReview.ts', command, form.reference, ...options], {
        cwd: backendDirectory, env: { ...process.env, MIGRATION_DB_USER: 'parent_rehearsal_operator', MIGRATION_DB_PASS: 'synthetic-operator-only',
            MIGRATION_CONFIRM_ACCOUNT: 'parent_rehearsal_operator@%', SIGNED_FORM_CONFIRM_DATABASE: 'mickeyf_migration_test',
            SIGNED_FORM_CONFIRM_SERVER_UUID: confirmedServerUuid, PARENT_FORM_RELAY_STATE_ENABLED: relayStateEnabled ? '1' : '0' },
        encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024, windowsHide: true, shell: false,
    });
    assert.equal(result.error, undefined, 'the real review CLI must finish within its local rehearsal bound');
    assert.equal(result.status, decisionSucceeds ? 0 : 1, `${label}: unexpected CLI result: ${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-operator-only|synthetic-runtime-only|migration-test-root-only/u);
    if (!decisionSucceeds) {
        assert.match(result.stderr, /Inspect the exact request before any retry/u); return null;
    }
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    if (command !== 'inspect') {
        assert.equal(output.decision, command);
        const row = await formRow(form.reference);
        assert.equal(row.reviewer, label); assert.equal(row.public_approved, 0);
        assert.deepEqual(row.form_sha256, createHash('sha256').update(contents).digest());
    }
    return output;
}

function pendingOutreach(confirmedServerUuid = serverUuid, relayStateEnabled = false) {
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register', 'ts/accounts/runSignedParentFormReview.ts', 'pending'], {
        cwd: backendDirectory, env: { ...process.env, MIGRATION_DB_USER: 'parent_rehearsal_operator', MIGRATION_DB_PASS: 'synthetic-operator-only',
            MIGRATION_CONFIRM_ACCOUNT: 'parent_rehearsal_operator@%', SIGNED_FORM_CONFIRM_DATABASE: 'mickeyf_migration_test',
            SIGNED_FORM_CONFIRM_SERVER_UUID: confirmedServerUuid, PARENT_FORM_RELAY_STATE_ENABLED: relayStateEnabled ? '1' : '0' },
        encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024, windowsHide: true, shell: false,
    });
    assert.equal(result.error, undefined);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-operator-only|synthetic-runtime-only|migration-test-root-only/u);
    return result;
}

test(`${label}: operator holds a disabled Apple relay and keeps delivery unknown after re-enablement`, async () => {
    await verifyParentFormAppleRelayWriteAccess(database);
    await admin.query("REVOKE DELETE ON mickeyf_migration_test.parent_form_apple_relay_state FROM 'parent_rehearsal_runtime'@'%'");
    try { await assert.rejects(verifyParentFormAppleRelayWriteAccess(database)); }
    finally { await admin.query("GRANT DELETE ON mickeyf_migration_test.parent_form_apple_relay_state TO 'parent_rehearsal_runtime'@'%'"); }
    const p = await parent('US', 'apple');
    const form = await p.requestForm();
    const [[clock]] = await admin.query<RowDataPacket[]>('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP()) AS now');
    const now = Number(clock.now);
    const event = { audience: 'com.example.app', subject: p.subject, eventType: 'email-disabled',
        issuedAt: now, eventTime: now, relayEmail: p.contact } as VerifiedAppleNotification;
    const recorder = { record: (value: VerifiedAppleNotification) => recordParentFormAppleRelayEvent(database, value) };
    await applyAppleNotification(database, event, recorder);
    const result = pendingOutreach(serverUuid, true);
    assert.equal(result.status, 0, result.stderr);
    const held = JSON.parse(result.stdout).requests.find((request: { reference: string }) => request.reference === form.reference);
    assert.equal(held.relayForwardingStatus, 'last-event-disabled'); assert.equal(held.deliveryStatus, 'unknown');
    assert.equal(held.verifiedContact, null);
    const inspected = await operator('inspect', form, true, serverUuid, true);
    assert.equal(inspected?.relay_forwarding_status, 'last-event-disabled'); assert.equal(inspected?.verified_contact, null);
    await applyAppleNotification(database, { ...event, eventType: 'email-enabled', eventTime: now + 1 }, recorder);
    const resumed = await operator('inspect', form, true, serverUuid, true);
    assert.equal(resumed?.relay_forwarding_status, 'last-event-enabled'); assert.equal(resumed?.verified_contact, p.contact);
    assert.equal(resumed?.delivery_status, 'unknown');
});

for (const country of ['BR', 'US']) test(`${label}: ${country} actual operator CLI approves/rejects, rejects expiry, creates privately and withdraws/deletes`, async () => {
    const p = await parent(country);
    const approved = await p.requestForm();
    const incorrect = pendingOutreach('00000000-0000-4000-8000-000000000001');
    assert.equal(incorrect.status, 1); assert.equal(incorrect.stdout, '');
    const queue = pendingOutreach(); assert.equal(queue.status, 0, queue.stderr);
    const found = JSON.parse(queue.stdout).requests.find((request: { reference: string }) => request.reference === approved.reference);
    assert.equal(found.verifiedContact, p.contact); assert.equal(found.country, country);
    assert.equal(found.provider, 'google'); assert.equal(found.providerLinked, true);
    assert.equal(found.policyDigest, (await formRow(approved.reference)).policy_digest.toString('hex').toUpperCase());
    assert.equal(found.policyVersion, policy.version); assert.equal(found.consentVersion, policy.consentVersion);
    const [[identity]] = await admin.query<RowDataPacket[]>('SELECT subject FROM account_provider_identities WHERE account_uuid=? AND provider=\'google\'', [p.account.accountId]);
    await admin.query('DELETE FROM account_provider_identities WHERE account_uuid=? AND provider=\'google\'', [p.account.accountId]);
    try {
        const unlinked = pendingOutreach(); assert.equal(unlinked.status, 0, unlinked.stderr);
        const held = JSON.parse(unlinked.stdout).requests.find((request: { reference: string }) => request.reference === approved.reference);
        assert.equal(held.providerLinked, false); assert.equal(held.verifiedContact, null);
        const inspectedHeld = await operator('inspect', approved);
        assert.equal(inspectedHeld?.provider_linked, 0); assert.equal(inspectedHeld?.verified_contact, null);
        assert.equal(inspectedHeld?.delivery_status, 'unknown');
        await operator('approve', approved, false);
        assert.equal((await formRow(approved.reference)).status, 'pending');
    } finally {
        await admin.query("INSERT INTO account_provider_identities (provider,subject,account_uuid,linked_at) VALUES ('google',?,?,UTC_TIMESTAMP(6))",
            [identity.subject, p.account.accountId]);
    }
    const pending = await operator('inspect', approved); assert.equal(pending?.status, 'pending'); assert.equal(pending?.user_name, null);
    assert.equal(pending?.country_code, country);
    await assert.rejects(database.query("UPDATE parent_signed_forms SET status='approved',reviewed_at=UTC_TIMESTAMP(6) WHERE reference=?", [approved.reference]),
        /command denied|UPDATE command denied/iu, 'website runtime must not become the operator');
    await operator('approve', approved, false, '00000000-0000-4000-8000-000000000001');
    assert.equal((await formRow(approved.reference)).status, 'pending', 'wrong server confirmation cannot approve a request');
    const credentials = { formReference: approved.reference, userName: `synthetic-child-${country}-${randomUUID()}`,
        password: 'SYNTHETIC-CHILD-PASSWORD-NOT-A-REAL-ACCOUNT' };
    const premature = await p.flow.begin(p.context, p.request); assert.ok('state' in premature);
    assert.ok('error' in await p.flow.complete(p.context, { state: premature.state, idToken: 'SYNTHETIC-NO-PROVIDER-REQUEST' }),
        'a proof without a reviewed form cannot produce a child-creation grant');
    await operator('approve', approved);
    const changedContactChallenge = await p.flow.begin(p.context, { ...p.request, formReference: approved.reference });
    assert.ok('state' in changedContactChallenge);
    Object.assign(p.identity, { email: 'synthetic-changed-contact@example.test' });
    try {
        const changedContact = await p.flow.complete(p.context, { state: changedContactChallenge.state, idToken: 'SYNTHETIC-NO-PROVIDER-REQUEST' });
        assert.ok('error' in changedContact, 'a different verified contact must not authorize the reviewed form');
    } finally { Object.assign(p.identity, { email: p.contact }); }
    const missingContactChallenge = await p.flow.begin(p.context, { ...p.request, formReference: approved.reference });
    assert.ok('state' in missingContactChallenge);
    Object.assign(p.identity, { email: undefined });
    try {
        assert.deepEqual(await p.flow.complete(p.context, { state: missingContactChallenge.state, idToken: 'SYNTHETIC-NO-PROVIDER-REQUEST' }),
            { error: 'VERIFIED_CONTACT_REQUIRED' });
    } finally { Object.assign(p.identity, { email: p.contact }); }
    if (country === 'BR') {
        const extraReferences = Array.from({ length: 100 }, () => randomUUID());
        try {
            for (const reference of extraReferences) await admin.query(`INSERT INTO parent_signed_forms
                (reference,parent_uuid,country_code,user_name,policy_digest,consent_version,policy_version,provider,subject,verified_contact,
                 status,submitted_at,expires_at,reviewed_at,reviewer,form_sha256,public_policy_digest,public_approved,public_withdrawn,child_uuid)
                SELECT ?,parent_uuid,country_code,user_name,policy_digest,consent_version,policy_version,provider,subject,verified_contact,
                 status,submitted_at,expires_at,reviewed_at,reviewer,form_sha256,public_policy_digest,public_approved,public_withdrawn,child_uuid
                FROM parent_signed_forms WHERE reference=?`, [reference, approved.reference]);
            const oversized = await p.flow.begin(p.context, { ...p.request, formReference: approved.reference });
            assert.ok('state' in oversized);
            assert.ok('error' in await p.flow.complete(p.context, { state: oversized.state, idToken: 'SYNTHETIC-NO-PROVIDER-REQUEST' }),
                'an oversized candidate set fails closed instead of accepting a truncated search');
        } finally {
            for (const reference of extraReferences) await admin.query('DELETE FROM parent_signed_forms WHERE reference=?', [reference]);
        }
    }
    const afterApproval = pendingOutreach(); assert.equal(afterApproval.status, 0, afterApproval.stderr);
    assert.equal(JSON.parse(afterApproval.stdout).requests.some((request: { reference: string }) => request.reference === approved.reference), false);
    assert.equal((await operator('inspect', approved))?.status, 'approved');
    const fresh = await p.proof({ ...p.request, formReference: approved.reference });
    const created = await p.flow.createChild(p.context, { ...credentials, grant: fresh }); assert.ok('created' in created, JSON.stringify(created));
    assert.equal(created.child.scoreVisibility, 'private');
    const [[child]] = await admin.query<RowDataPacket[]>('SELECT email FROM users WHERE account_uuid=?', [created.child.accountId]);
    assert.equal(child.email, null); assert.equal((await formRow(approved.reference)).status, 'used');
    assert.ok('error' in await p.flow.createChild(p.context, { ...credentials, grant: fresh }), 'approval and fresh proof remain single-use');
    const withdrawal = await p.proof({ purpose: 'withdraw-child', childAccountId: created.child.accountId, clientKey: 'google-web',
        policyVersion: policy.version, confirmation: 'WITHDRAW AND DELETE' });
    assert.deepEqual(await p.flow.withdrawChild(p.context, { grant: withdrawal, confirmation: 'WITHDRAW AND DELETE' }), { deleted: true });
    assert(deletionIntents.includes(created.child.accountId));
    assert.equal((await admin.query<RowDataPacket[]>('SELECT account_uuid FROM users WHERE account_uuid=?', [created.child.accountId]))[0].length, 0);
    assert(await readLiveSession(database, p.account.userId, p.account.accountId, p.context.session!.sessionId));

    const rejected = await p.requestForm(); await operator('reject', rejected);
    assert.equal((await operator('inspect', rejected))?.status, 'rejected');
    const afterRejection = pendingOutreach(); assert.equal(afterRejection.status, 0, afterRejection.stderr);
    assert.equal(JSON.parse(afterRejection.stdout).requests.some((request: { reference: string }) => request.reference === rejected.reference), false);
    await operator('approve', rejected, false);
    assert.ok('error' in await p.flow.begin(p.context, { ...p.request, formReference: rejected.reference }),
        'a rejected form cannot start a child-creation proof');
    const expired = await p.requestForm();
    await admin.query('UPDATE parent_signed_forms SET expires_at=UTC_TIMESTAMP(6)-INTERVAL 1 SECOND WHERE reference=?', [expired.reference]);
    const afterExpiry = pendingOutreach(); assert.equal(afterExpiry.status, 0, afterExpiry.stderr);
    assert.equal(JSON.parse(afterExpiry.stdout).requests.some((request: { reference: string }) => request.reference === expired.reference), false);
    await operator('approve', expired, false);
    const expiredRow = await formRow(expired.reference); assert.equal(expiredRow.status, 'pending'); assert.equal(expiredRow.reviewer, null);
    assert.ok('error' in await p.flow.begin(p.context, { ...p.request, formReference: expired.reference }),
        'an expired form cannot start a child-creation proof');
    assert.deepEqual(await cleanupSignedParentForms(database), { backlog: false });
    assert.equal((await admin.query<RowDataPacket[]>('SELECT reference FROM parent_signed_forms WHERE reference=?', [expired.reference]))[0].length, 0);
    assert.equal((await formRow(rejected.reference)).status, 'rejected', 'unexpired rejected review history survives expiry cleanup');
    assert.deepEqual(await p.flow.listChildren(p.context, {}), { children: [] });
});
