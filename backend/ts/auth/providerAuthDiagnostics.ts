const STAGES = [
    'context-read', 'flow-complete', 'registration-check', 'attempt-consume', 'provider-verification', 'apple-token-exchange',
    'account-lookup', 'account-create', 'account-link', 'account-delete', 'credential-save',
    'registration-consume', 'apple-token-store', 'account-transaction', 'session-establish',
    'apple-exchange-response', 'apple-exchange-verification', 'apple-exchange-identity', 'apple-exchange-nonce-missing',
] as const;
export type ProviderAuthFailureStage = typeof STAGES[number];

const SQL_CODES = [
    'ER_ACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR',
    'ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'ER_DUP_ENTRY', 'ER_CHECK_CONSTRAINT_VIOLATED',
    'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'PROTOCOL_SEQUENCE_TIMEOUT',
] as const;
const TRANSPORT_CODES = ['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'] as const;
const APPLE_ERRORS = ['invalid_client', 'invalid_grant', 'invalid_request', 'unauthorized_client',
    'unsupported_grant_type', 'invalid_scope'] as const;
const TRANSACTIONS = ['not-started', 'begin-unconfirmed', 'active', 'rollback-unconfirmed', 'rolled-back',
    'commit-unconfirmed', 'committed'] as const;
const STEPS = ['connect', 'begin', 'identity-lookup', 'user-insert', 'account-read', 'identity-insert',
    'credential-write', 'commit', 'release'] as const;
const APPLE_RESPONSE_FIELDS = ['document', 'id-token', 'refresh-token'] as const;
export type ProviderAuthTransactionState = typeof TRANSACTIONS[number];
export type ProviderAuthTransactionStep = typeof STEPS[number];

type DiagnosticDetails = Readonly<{
    appleStatus?: number;
    appleError?: unknown;
    transaction?: ProviderAuthTransactionState;
    transactionStep?: ProviderAuthTransactionStep;
    appleResponseField?: typeof APPLE_RESPONSE_FIELDS[number];
}>;
type DiagnosticEvent = {
    event: 'provider_auth_failure';
    severity: 'WARNING';
    stage: ProviderAuthFailureStage;
    category: 'database' | 'transport' | 'apple-response' | 'unclassified';
    sqlCode?: typeof SQL_CODES[number];
    transportCode?: typeof TRANSPORT_CODES[number];
    appleHttp?: '400' | '401' | '403' | '429' | '5xx' | 'other';
    appleError?: typeof APPLE_ERRORS[number];
    transaction?: typeof TRANSACTIONS[number];
    transactionStep?: typeof STEPS[number];
    appleResponseField?: typeof APPLE_RESPONSE_FIELDS[number];
};

function allowed<T extends string>(values: readonly T[], value: unknown): value is T {
    return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Diagnostics must neither expose raw failures nor change authentication or transaction outcomes. */
export function reportProviderAuthFailure(stage: ProviderAuthFailureStage, error: unknown,
    details: DiagnosticDetails = {}): void {
    try {
        if (!allowed(STAGES, stage)) return;
        const event: DiagnosticEvent = { event: 'provider_auth_failure', severity: 'WARNING', stage, category: 'unclassified' };
        const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (allowed(SQL_CODES, code)) { event.sqlCode = code; event.category = 'database'; }
        if (allowed(TRANSPORT_CODES, code)) { event.transportCode = code; event.category = 'transport'; }
        const status = details.appleStatus;
        if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
            event.appleHttp = status === 400 ? '400' : status === 401 ? '401' : status === 403 ? '403'
                : status === 429 ? '429' : status >= 500 ? '5xx' : 'other';
            if (event.category === 'unclassified') event.category = 'apple-response';
        }
        if (allowed(APPLE_ERRORS, details.appleError)) event.appleError = details.appleError;
        if (allowed(TRANSACTIONS, details.transaction)) event.transaction = details.transaction;
        if (allowed(STEPS, details.transactionStep)) event.transactionStep = details.transactionStep;
        if (stage === 'apple-exchange-response' && allowed(APPLE_RESPONSE_FIELDS, details.appleResponseField)) {
            event.appleResponseField = details.appleResponseField;
        }
        console.warn(JSON.stringify(event));
    } catch { /* Even inspection of an error or the logger itself may fail. */ }
}
