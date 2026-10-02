import { GoogleAuth } from 'google-auth-library';
import mysql from 'mysql2/promise';
import { loadDeletionAuditConfig } from '../config/deletionAuditConfig';
import { auditPendingDeletions } from './deletionAudit';
import type { DeletionJournalReader } from './deletionJournal';
import { createGcsDeletionJournal } from './gcsDeletionJournal';

const RECOVERY_READER = 'ludolume-deletion-recovery@noted-reef-387021.iam.gserviceaccount.com';

function auditJournal(maxDurationMs: number): DeletionJournalReader {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.read_only'] });
    return {
        async readDeletionIntents() {
            // Check the actual ADC/impersonation identity, not an environment-variable assertion.
            if ((await auth.getCredentials()).client_email !== RECOVERY_READER) {
                throw new Error('Deletion audit requires the recovery reader identity');
            }
            const journal = createGcsDeletionJournal({
                readTimeoutMs: maxDurationMs,
                client: {
                    async request(options) {
                        if (options.method !== 'GET') throw new Error('Deletion audit is read-only');
                        const client = await auth.getClient();
                        const headers = await client.getRequestHeaders(options.url);
                        options.signal.throwIfAborted();
                        return client.transporter.request({ ...options, headers });
                    },
                },
            });
            return journal.readDeletionIntents();
        },
    };
}

export async function runDeletionAudit(): Promise<void> {
    const config = loadDeletionAuditConfig();
    const database = mysql.createPool(config.databaseOptions);
    try {
        const result = await auditPendingDeletions(database, auditJournal(config.settings.maxDurationMs), config.settings);
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
