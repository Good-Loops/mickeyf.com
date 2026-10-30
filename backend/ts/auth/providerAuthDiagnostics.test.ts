import assert from 'node:assert/strict';
import test from 'node:test';
import { reportProviderAuthFailure } from './providerAuthDiagnostics';

test('diagnostics serialize only finite primitive fields and exclude raw error/provider details', () => {
    const lines: unknown[][] = [];
    const original = console.warn;
    console.warn = (...values: unknown[]) => { lines.push(values); };
    try {
        const sensitive = 'PRIVATE-identity-token-email-password-SQL-parameter';
        reportProviderAuthFailure('registration-consume', Object.assign(new Error(sensitive), {
            code: 'ER_TABLEACCESS_DENIED_ERROR', cause: sensitive, sql: sensitive, parameters: [sensitive],
            accountId: sensitive, subject: sensitive,
        }), { transaction: 'active', transactionStep: 'credential-write' });
        reportProviderAuthFailure('apple-token-exchange', new Error(sensitive), {
            appleStatus: 400, appleError: 'invalid_client',
        });
        reportProviderAuthFailure('apple-token-exchange', { code: sensitive }, {
            appleStatus: NaN, appleError: sensitive,
            transaction: sensitive, transactionStep: sensitive,
        } as unknown as Parameters<typeof reportProviderAuthFailure>[2]);
        reportProviderAuthFailure(sensitive as Parameters<typeof reportProviderAuthFailure>[0], new Error(sensitive));
        assert.equal(lines.length, 3);
        assert(lines.every(values => values.length === 1 && typeof values[0] === 'string' && !values[0].includes('\n')));
        assert.doesNotMatch(JSON.stringify(lines), /PRIVATE|accountId|subject|parameters|cause|stack|password|SQL-parameter/u);
        assert.deepEqual(lines.map(values => JSON.parse(values[0] as string)), [
            { event: 'provider_auth_failure', severity: 'WARNING', stage: 'registration-consume', category: 'database',
                sqlCode: 'ER_TABLEACCESS_DENIED_ERROR', transaction: 'active', transactionStep: 'credential-write' },
            { event: 'provider_auth_failure', severity: 'WARNING', stage: 'apple-token-exchange', category: 'apple-response',
                appleHttp: '400', appleError: 'invalid_client' },
            { event: 'provider_auth_failure', severity: 'WARNING', stage: 'apple-token-exchange', category: 'unclassified' },
        ]);
    } finally { console.warn = original; }
});

test('network codes remain transport failures rather than database failures', () => {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = line => { lines.push(line); };
    try {
        reportProviderAuthFailure('apple-token-exchange', { code: 'ECONNRESET' });
        assert.deepEqual(JSON.parse(lines[0]), { event: 'provider_auth_failure', severity: 'WARNING',
            stage: 'apple-token-exchange', category: 'transport', transportCode: 'ECONNRESET' });
    } finally { console.warn = original; }
});

test('response field diagnostics accept only allowlisted fields at the exchange response stage', () => {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = line => { lines.push(line); };
    try {
        reportProviderAuthFailure('apple-exchange-response', undefined, { appleResponseField: 'refresh-token' });
        reportProviderAuthFailure('apple-token-exchange', undefined, { appleResponseField: 'id-token' });
        reportProviderAuthFailure('apple-exchange-response', undefined, {
            appleResponseField: 'PRIVATE-value',
        } as unknown as Parameters<typeof reportProviderAuthFailure>[2]);
        assert.deepEqual(lines.map(line => JSON.parse(line)), [
            { event: 'provider_auth_failure', severity: 'WARNING', stage: 'apple-exchange-response',
                category: 'unclassified', appleResponseField: 'refresh-token' },
            { event: 'provider_auth_failure', severity: 'WARNING', stage: 'apple-token-exchange', category: 'unclassified' },
            { event: 'provider_auth_failure', severity: 'WARNING', stage: 'apple-exchange-response', category: 'unclassified' },
        ]);
        assert.doesNotMatch(JSON.stringify(lines), /PRIVATE/u);
    } finally { console.warn = original; }
});

test('throwing error inspection or logging never changes the caller outcome', () => {
    const original = console.warn;
    try {
        const failure = Object.defineProperty({}, 'code', { get() { throw new Error('PRIVATE getter'); } });
        console.warn = () => { throw new Error('PRIVATE logger'); };
        assert.doesNotThrow(() => reportProviderAuthFailure('account-create', failure));
        assert.doesNotThrow(() => reportProviderAuthFailure('session-establish', new Error('PRIVATE failure')));
        assert.doesNotThrow(() => reportProviderAuthFailure('apple-token-exchange', undefined,
            Object.defineProperty({}, 'appleStatus', { get() { throw new Error('PRIVATE details getter'); } })));
    } finally { console.warn = original; }
});
