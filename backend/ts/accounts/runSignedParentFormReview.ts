import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import { verifySignedParentFormReadiness } from '../migrations/signedParentFormSchema';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { reviewSignedParentForm } from './signedParentFormReview';
import { pendingParentFormOutreach, redactUnavailableFormContact, relayForwardingStatusSql } from './signedParentFormOutreach';
import { verifyParentFormAppleRelayReadiness } from './parentFormAppleRelayReadiness';

async function main() {
    const [command, reference, ...arguments_] = process.argv.slice(2);
    if (!['pending', 'inspect', 'approve', 'reject'].includes(command)) throw new Error('Unknown review command.');
    if (command === 'pending') {
        if ((reference !== undefined && !/^--after=[0-9a-f-]{36}$/u.test(reference)) || arguments_.length !== 0) throw new Error('Invalid pending-request cursor.');
    } else if (!/^[0-9a-f-]{36}$/u.test(reference ?? '')) throw new Error('Invalid request reference.');
    const values = new Map<string, string>();
    for (const argument of arguments_) {
        const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
        if (!match || values.has(match[1])) throw new Error('Review options must be unique --name=value pairs.');
        values.set(match[1], match[2]);
    }
    const expectedOptions = command === 'inspect' || command === 'pending' ? [] : ['contact', 'form-file', 'parent-account', 'policy-digest', 'public-permission', 'reviewer', 'signed-parent-reviewed'];
    if ([...values.keys()].sort().join(',') !== expectedOptions.sort().join(',')) throw new Error('Missing or unknown review option.');
    const relayFlag = process.env.PARENT_FORM_RELAY_STATE_ENABLED;
    if (relayFlag !== undefined && !['0', '1'].includes(relayFlag)) throw new Error('Invalid relay-state configuration.');
    const relayStateEnabled = relayFlag === '1';
    const config = loadMigrationConfig();
    const database = mysql.createPool({ host: config.host, port: config.port, user: config.user,
        password: config.password, database: config.database, connectTimeout: config.operationTimeoutMs,
        connectionLimit: 1, timezone: 'Z', dateStrings: true });
    try {
        const [identity] = await database.query<RowDataPacket[]>('SELECT DATABASE() AS databaseName, @@server_uuid AS serverUuid, CURRENT_USER() AS currentUser');
        if (identity.length !== 1 || identity[0].databaseName !== process.env.SIGNED_FORM_CONFIRM_DATABASE
            || identity[0].serverUuid !== process.env.SIGNED_FORM_CONFIRM_SERVER_UUID
            || identity[0].currentUser !== process.env.MIGRATION_CONFIRM_ACCOUNT) throw new Error('Database, server or administrative account confirmation mismatch.');
        await verifySignedParentFormReadiness(database as unknown as MigrationConnection);
        if (relayStateEnabled) await verifyParentFormAppleRelayReadiness(database);
        if (command === 'pending') {
            console.log(JSON.stringify(await pendingParentFormOutreach(database, reference?.slice('--after='.length) ?? null, relayStateEnabled), null, 2)); return;
        }
        if (command === 'inspect') {
            const [forms] = await database.query<RowDataPacket[]>({ sql: `SELECT f.reference, f.parent_uuid, f.country_code, f.user_name, f.verified_contact,
                HEX(f.policy_digest) AS policy_digest, f.consent_version, f.policy_version, f.status, f.expires_at,
                HEX(f.public_policy_digest) AS public_policy_digest, f.provider,
                ${relayForwardingStatusSql(relayStateEnabled)} AS relay_forwarding_status,
                EXISTS (SELECT 1 FROM account_provider_identities i WHERE i.account_uuid=f.parent_uuid
                    AND i.provider=f.provider AND i.subject=f.subject) AS provider_linked
                FROM parent_signed_forms f WHERE f.reference=? LIMIT 1`, timeout: 10_000 }, [reference]);
            if (forms.length !== 1) throw new Error('Request is unavailable.');
            const form = forms[0] as RowDataPacket & { provider_linked: unknown; verified_contact: unknown; relay_forwarding_status: unknown };
            console.log(JSON.stringify(redactUnavailableFormContact(form), null, 2)); return;
        }
        if (values.get('signed-parent-reviewed') !== 'true' || !['true', 'false'].includes(values.get('public-permission')!)
            || !/^[0-9a-f]{64}$/iu.test(values.get('policy-digest')!)) throw new Error('Explicit completed review and exact policy digest are required.');
        const filePath = values.get('form-file')!;
        const size = statSync(filePath);
        if (!size.isFile() || size.size < 1 || size.size > 10 * 1024 * 1024) throw new Error('Signed form must be a regular file no larger than 10 MiB.');
        // The owner runs this privately; file contents are never printed, copied or uploaded by this tool.
        const formSha256 = createHash('sha256').update(readFileSync(filePath)).digest();
        await reviewSignedParentForm(database, { reference, parentAccountId: values.get('parent-account')!,
            verifiedContact: values.get('contact')!, policyDigest: Buffer.from(values.get('policy-digest')!, 'hex'),
            formSha256, reviewer: values.get('reviewer')!, decision: command === 'approve' ? 'approved' : 'rejected',
            publicApproved: values.get('public-permission') === 'true' });
        console.log(JSON.stringify({ reference, decision: command, publicPermission: values.get('public-permission') === 'true' }));
    } finally { await database.end(); }
}
void main().catch(() => {
    console.error('Signed form review failed or its outcome is unconfirmed. Inspect the exact request before any retry. No signed form or database credentials were printed.');
    process.exitCode = 1;
});
