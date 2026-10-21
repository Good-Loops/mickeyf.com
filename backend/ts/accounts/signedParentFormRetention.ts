import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { observeChildSignedFormMetadata, type ChildSignedFormMetadataSettings,
    type ChildSignedFormMetadataSnapshot, type ChildSignedFormSource, type ChildSignedFormTarget } from '../migrations/childSignedFormMetadata';
import { assertChildSignedFormSql, CHILD_SIGNED_FORM_SQL_SHA256 } from '../migrations/childSignedFormOperation';

export const SIGNED_FORM_RETENTION_FAILURE = 'Signed parent form retention lookup unavailable; no complete report or absence was confirmed.';
const fail = (): never => { throw new Error(SIGNED_FORM_RETENTION_FAILURE); };
const referencePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export type SignedParentFormRetentionRequest = Readonly<{
    reference: string;
    state: 'used' | 'pending' | 'approved' | 'rejected' | 'expired-unused' | 'not-found';
    expiresAt: string | null;
}>;
export type SignedParentFormRetentionReport = Readonly<{
    schemaVersion: 1; operation: 'observe-signed-parent-form-retention'; observedAt: string;
    sourceCommit: string; target: ChildSignedFormTarget; schemaSha256: string; grantsSha256: string;
    requests: readonly SignedParentFormRetentionRequest[];
}>;
export type SignedParentFormRetentionDependencies = Readonly<{
    connection: MigrationConnection; settings: ChildSignedFormMetadataSettings; source: ChildSignedFormSource;
    assertSource?: () => void; now?: () => number;
}>;

function references(value: unknown): readonly string[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 100) return fail();
    const result: string[] = [];
    for (const reference of value) {
        if (typeof reference !== 'string' || !referencePattern.test(reference) || result.includes(reference)) return fail();
        result.push(reference);
    }
    return Object.freeze(result);
}

/** Only request references cross this boundary; a private ledger or file path is never an input. */
export function parseSignedParentFormRetentionInput(value: unknown): readonly string[] {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'references') return fail();
    return references((value as { references?: unknown }).references);
}

function assertSource(deps: SignedParentFormRetentionDependencies): void {
    deps.assertSource?.();
    if (!/^[a-f0-9]{40}$/u.test(deps.source.sourceCommit) || deps.source.sqlSha256 !== CHILD_SIGNED_FORM_SQL_SHA256) fail();
    assertChildSignedFormSql(readFileSync(path.resolve(__dirname, '../../migrations/pending/0028_extend_child_signed_parent_forms.sql')));
}

function stableMetadata(snapshot: ChildSignedFormMetadataSnapshot): string {
    return JSON.stringify({ target: snapshot.target, identity: snapshot.identity, history: snapshot.history,
        capability: snapshot.capability, schemaSha256: snapshot.schemaSha256, grantsSha256: snapshot.grantsSha256 });
}

function expiry(value: unknown): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value)
        || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== `${value.slice(0, 23)}Z`) return fail();
    return value;
}

/** A successful report observes SQL lifecycle state, not signature validity or permission to delete files. */
export async function observeSignedParentFormRetention(deps: SignedParentFormRetentionDependencies,
    input: readonly string[]): Promise<SignedParentFormRetentionReport> {
    try {
        const requested = references(input);
        assertSource(deps);
        const before = await observeChildSignedFormMetadata(deps.connection, deps.settings);
        const [rows] = await deps.connection.query(`SELECT reference, status,
            DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS expiresAt,
            (expires_at <= UTC_TIMESTAMP(6)) AS expired
            FROM parent_signed_forms WHERE reference IN (${requested.map(() => '?').join(',')}) ORDER BY reference LIMIT 101`, [...requested]);
        if (!Array.isArray(rows) || rows.length > requested.length) return fail();
        const found = new Map<string, SignedParentFormRetentionRequest>();
        for (const row of rows) {
            if (!row || typeof row !== 'object' || Array.isArray(row)
                || Object.keys(row).sort().join(',') !== 'expired,expiresAt,reference,status'
                || typeof row.reference !== 'string' || !requested.includes(row.reference) || found.has(row.reference)
                || !['pending', 'approved', 'rejected', 'used'].includes(row.status) || ![0, 1].includes(row.expired)) return fail();
            const state: SignedParentFormRetentionRequest['state'] = row.status === 'used' ? 'used'
                : row.status === 'rejected' ? 'rejected' : row.expired === 1 ? 'expired-unused' : row.status;
            found.set(row.reference, Object.freeze({ reference: row.reference, state, expiresAt: expiry(row.expiresAt) }));
        }
        const after = await observeChildSignedFormMetadata(deps.connection, deps.settings);
        if (stableMetadata(before) !== stableMetadata(after)) return fail();
        assertSource(deps);
        const now = (deps.now ?? Date.now)();
        if (!Number.isSafeInteger(now) || now < 0) return fail();
        return Object.freeze({ schemaVersion: 1, operation: 'observe-signed-parent-form-retention', observedAt: new Date(now).toISOString(),
            sourceCommit: deps.source.sourceCommit, target: Object.freeze({ ...after.target }),
            schemaSha256: after.schemaSha256, grantsSha256: after.grantsSha256,
            requests: Object.freeze(requested.map(reference => found.get(reference)
                ?? Object.freeze({ reference, state: 'not-found' as const, expiresAt: null }))) });
    } catch { return fail(); }
}
