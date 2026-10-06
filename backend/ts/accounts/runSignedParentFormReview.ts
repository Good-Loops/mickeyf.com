import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import { verifySignedParentFormReadiness } from '../migrations/signedParentFormSchema';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { reviewSignedParentForm } from './signedParentFormReview';

async function main() {
    const [command, reference, ...arguments_] = process.argv.slice(2);
    if (!['inspect', 'approve', 'reject'].includes(command) || !/^[0-9a-f-]{36}$/u.test(reference ?? '')) throw new Error('Usage: inspect|approve|reject <reference> [review options]');
    const values = new Map<string, string>();
    for (const argument of arguments_) {
        const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
        if (!match || values.has(match[1])) throw new Error('Review options must be unique --name=value pairs.');
        values.set(match[1], match[2]);
    }
    const expectedOptions = command === 'inspect' ? [] : ['contact', 'form-file', 'parent-account', 'policy-digest', 'public-permission', 'reviewer', 'signed-parent-reviewed'];
    if ([...values.keys()].sort().join(',') !== expectedOptions.sort().join(',')) throw new Error('Missing or unknown review option.');
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
        if (command === 'inspect') {
            const [forms] = await database.query<RowDataPacket[]>({ sql: `SELECT reference, parent_uuid, country_code, user_name, verified_contact,
                HEX(policy_digest) AS policy_digest, consent_version, policy_version, status, expires_at,
                HEX(public_policy_digest) AS public_policy_digest FROM parent_signed_forms WHERE reference=? LIMIT 1`, timeout: 10_000 }, [reference]);
            if (forms.length !== 1) throw new Error('Request is unavailable.');
            console.log(JSON.stringify(forms[0], null, 2)); return;
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
