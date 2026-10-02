export interface DeletionIntent {
    version: 1;
    accountId: string;
    action: 'delete-account' | 'withdraw-public-scores';
    requestedAt: string;
}

export interface AccountDeletionJournal {
    recordAccountDeletion(accountId: string): Promise<void>;
    recordPublicScoreWithdrawal?(accountId: string): Promise<void>;
}

export interface DeletionJournalSnapshot {
    intents: readonly DeletionIntent[];
    digest: string;
}

export interface DeletionJournalReader {
    readDeletionIntents(): Promise<DeletionJournalSnapshot>;
}

/** MySQL-generated identities use UUIDv1; UUIDv4 is accepted for future random identities. */
export function isAccountId(value: unknown): value is string {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[14][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function assertAccountId(value: unknown): asserts value is string {
    if (!isAccountId(value)) throw new Error('Invalid stable account identity');
}

/** Reject unknown fields so this journal cannot quietly become a store of personal data. */
export function parseDeletionIntent(value: unknown): DeletionIntent {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Invalid deletion intent');
    }
    const intent = value as Record<string, unknown>;
    if (Object.keys(intent).sort().join(',') !== 'accountId,action,requestedAt,version'
        || intent.version !== 1 || (intent.action !== 'delete-account' && intent.action !== 'withdraw-public-scores')
        || !isAccountId(intent.accountId) || !isUtcTimestamp(intent.requestedAt)) {
        throw new Error('Invalid deletion intent');
    }
    return {
        version: 1,
        accountId: intent.accountId,
        action: intent.action,
        requestedAt: intent.requestedAt,
    };
}

function isUtcTimestamp(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
        return false;
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
