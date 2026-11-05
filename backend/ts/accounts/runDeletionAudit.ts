import '../runtime/fetchRuntime';
import { GoogleAuth } from 'google-auth-library';
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { loadDeletionAuditConfig, type DeletionAuditSettings } from '../config/deletionAuditConfig';
import { auditPendingDeletions } from './deletionAudit';
import type { DeletionJournalReader } from './deletionJournal';
import { createGcsRetentionJournal } from './gcsRetentionJournal';
import { createGuardedDeletionAuditReader } from './guardedDeletionAuditReader';

const RECOVERY_READER = 'ludolume-deletion-recovery@noted-reef-387021.iam.gserviceaccount.com';

function auditJournal(settings: DeletionAuditSettings): DeletionJournalReader {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.read_only'] });
    return {
        async readDeletionIntents(connection) {
            // Check the actual ADC/impersonation identity, not an environment-variable assertion.
            if ((await auth.getCredentials()).client_email !== RECOVERY_READER) {
                throw new Error('Deletion audit requires the recovery reader identity');
            }
            if (!connection) throw new Error('Deletion audit requires its pinned database connection');
            const client = {
                    async request(options) {
                        if (options.method !== 'GET') throw new Error('Deletion audit is read-only');
                        const authClient = await auth.getClient();
                        const headers = await authClient.getRequestHeaders(options.url);
                        options.signal.throwIfAborted();
                        return authClient.transporter.request({ ...options, headers });
                    },
                } satisfies import('./gcsDeletionJournal').JournalHttpClient;
            const keyHex = process.env.RETENTION_GUARD_READ_KEY ?? '';
            if (!/^[a-f0-9]{64}$/u.test(keyHex)) throw new Error('Audit guard key unavailable');
            const journalKey = Buffer.from(keyHex, 'hex');
            const guard = createGcsRetentionJournal({ bucket: process.env.RETENTION_JOURNAL_BUCKET ?? '',
                expectedBucket: process.env.RETENTION_CONFIRM_BUCKET ?? '', key: journalKey, client,
                verifyActivityContinuity: async () => false });
            await guard.assertRestoreGuardHistory();
            const publicKey = process.env.RETIREMENT_PUBLIC_KEY_FILE
                ? createPublicKey(readFileSync(process.env.RETIREMENT_PUBLIC_KEY_FILE)) : undefined;
            return createGuardedDeletionAuditReader({ guard, publicKey, client, readTimeoutMs: settings.maxDurationMs,
                pins: { database: settings.database, currentUser: settings.expectedCurrentUser,
                    serverUuid: settings.expectedServerUuid } }).readDeletionIntents(connection);
        },
    };
}

export async function runDeletionAudit(): Promise<void> {
    const config = loadDeletionAuditConfig();
    const database = mysql.createPool(config.databaseOptions);
    try {
        const result = await auditPendingDeletions(database, auditJournal(config.settings), config.settings);
        console.log(JSON.stringify({
            component: 'account-deletion-audit', severity: result.status === 'pending' ? 'ERROR' : 'INFO', ...result,
        }));
        if (result.status === 'pending') process.exitCode = 2;
    } finally { await database.end(); }
}

if (require.main === module) {
    runDeletionAudit().catch(() => {
        console.error(JSON.stringify({ component: 'account-deletion-audit', severity: 'ERROR', status: 'failed' }));
        process.exitCode = 1;
    });
}
