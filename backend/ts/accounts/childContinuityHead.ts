import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isAccountId } from './deletionJournal';

const HEX = /^[a-f0-9]{64}$/u;
const GEN = /^[1-9][0-9]{0,19}$/u;
const ZERO = '0'.repeat(64);

export type ContinuityHead = Readonly<{ sequence: number; token: string; generation: string; digest: string;
    ledgerDigest: string; stateDigest: string; observedAt: number }>;
export type ContinuityOperation = Readonly<{ id: string; requestDigest: string; issuedAt: number; expiresAt: number; mac: string }>;
/** Read under the same SQL transaction and lock as the business operation. */
export type ContinuityLedgerRow = Readonly<{ childId: string; id: string; requestDigest: string;
    expiresAt: number; sequence: number; token: string }>;
type Found = Readonly<{ kind: 'found'; name: string; generation: string; body: string; live: true }>;
type HeadRead = Found | Readonly<{ kind: 'absent'; historyEmpty: true }>;

/**
 * This is an adapter contract, not a GCS implementation. The adapter must use
 * fresh metadata and a generation-pinned read with checksum verification; a
 * missing head is valid only after complete version and soft-delete checks.
 * Writes must use the exact ifGenerationMatch value, with automatic retries off.
 */
export type ContinuityHeadStorage = Readonly<{
    read(name: string, signal: AbortSignal): Promise<HeadRead>;
    replace(name: string, body: string, expectedGeneration: string, signal: AbortSignal): Promise<Found>;
}>;
export class ContinuityHeadUnavailableError extends Error {
    constructor() { super('Child continuity is unavailable or uncertain; reconciliation is required.'); }
}

/**
 * EXPERIMENTAL: call under a shared per-child SQL lock and transaction only.
 * Every relevant writer, including hold/contact/keep writers, must participate.
 * The independent head, its generation and the ledger must be protected from
 * rollback or deletion by separate IAM and qualified operational procedures.
 */
export function createContinuityHead(storage: ContinuityHeadStorage, secret: Buffer, timeoutMs = 10_000,
    generationScope: 'same-object' | 'distinct-objects' = 'same-object') {
    if (!storage || typeof storage.read !== 'function' || typeof storage.replace !== 'function'
        || !Buffer.isBuffer(secret) || secret.length !== 32 || !Number.isInteger(timeoutMs)
        || timeoutMs < 1 || timeoutMs > 10_000 || !['same-object', 'distinct-objects'].includes(generationScope)) {
        throw new TypeError('Invalid continuity head configuration.');
    }
    const key = Buffer.from(secret);
    async function bounded<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const deadline = new Promise<never>((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new ContinuityHeadUnavailableError()); }, timeoutMs);
            });
            return await Promise.race([call(controller.signal), deadline]);
        } finally { if (timer !== undefined) clearTimeout(timer); }
    }
    function nameFor(childId: string): string {
        if (!isAccountId(childId)) throw new TypeError('Invalid child identity.');
        const tag = createHmac('sha256', key).update('ludolume-child-head-id-v1\0').update(childId).digest('hex');
        return `v1/heads/${tag}.json`;
    }
    const replayWindowMs = 24 * 60 * 60 * 1000;
    function operationMac(childId: string, operation: Omit<ContinuityOperation, 'mac'>): string {
        return createHmac('sha256', key).update('ludolume-child-operation-v1\0').update(childId)
            .update(JSON.stringify(operation)).digest('hex');
    }
    function digestRequest(childId: string, request: Buffer): string {
        if (!Buffer.isBuffer(request) || request.length < 1 || request.length > 4096) throw new TypeError('Invalid canonical request.');
        return createHmac('sha256', key).update('ludolume-child-request-v1\0').update(childId).update(request).digest('hex');
    }
    function digestState(childId: string, state: Buffer): string {
        if (!Buffer.isBuffer(state) || state.length < 1 || state.length > 16_384) throw new TypeError('Invalid canonical child state.');
        return createHmac('sha256', key).update('ludolume-child-state-v1\0').update(childId).update(state).digest('hex');
    }
    function validateOperation(childId: string, operation: ContinuityOperation, databaseNow: number, request: Buffer): void {
        if (!operation || typeof operation.id !== 'string' || !HEX.test(operation.id)
            || typeof operation.requestDigest !== 'string' || !HEX.test(operation.requestDigest)
            || !Number.isSafeInteger(operation.issuedAt) || operation.issuedAt < 0
            || !Number.isSafeInteger(operation.expiresAt) || operation.expiresAt !== operation.issuedAt + replayWindowMs
            || !Number.isSafeInteger(databaseNow) || databaseNow < operation.issuedAt || databaseNow > operation.expiresAt
            || typeof operation.mac !== 'string' || !HEX.test(operation.mac)) throw new TypeError('Invalid or expired operation identity.');
        const unsigned = { id: operation.id, requestDigest: operation.requestDigest,
            issuedAt: operation.issuedAt, expiresAt: operation.expiresAt };
        if (!timingSafeEqual(Buffer.from(operation.mac, 'hex'), Buffer.from(operationMac(childId, unsigned), 'hex'))) {
            throw new TypeError('Invalid or expired operation identity.');
        }
        if (!timingSafeEqual(Buffer.from(operation.requestDigest, 'hex'), Buffer.from(digestRequest(childId, request), 'hex'))) {
            throw new TypeError('Operation does not match the canonical request.');
        }
    }
    function ledgerDigest(childId: string, rows: readonly ContinuityLedgerRow[], maxSequence: number): string {
        if (!Array.isArray(rows) || rows.length > 2048) throw new ContinuityHeadUnavailableError();
        const sorted = [...rows].sort((a, b) => String(a?.id).localeCompare(String(b?.id), 'en'));
        let previousId = '';
        for (const row of sorted) {
            if (!row || typeof row !== 'object' || Array.isArray(row)
                || Object.keys(row).sort().join(',') !== 'childId,expiresAt,id,requestDigest,sequence,token'
                || row.childId !== childId || typeof row.id !== 'string' || !HEX.test(row.id) || row.id === previousId
                || typeof row.requestDigest !== 'string' || !HEX.test(row.requestDigest)
                || !Number.isSafeInteger(row.expiresAt) || row.expiresAt < 1
                || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || row.sequence > maxSequence
                || typeof row.token !== 'string' || !HEX.test(row.token)) throw new ContinuityHeadUnavailableError();
            previousId = row.id;
        }
        // Fixed field order prevents driver-specific object serialization differences.
        const normalized = sorted.map(row => ({ childId: row.childId, id: row.id, requestDigest: row.requestDigest,
            expiresAt: row.expiresAt, sequence: row.sequence, token: row.token }));
        return createHmac('sha256', key).update('ludolume-child-ledger-v1\0').update(childId)
            .update(JSON.stringify(normalized)).digest('hex');
    }
    function bodyFor(name: string, sequence: number, previousGeneration: string, previousDigest: string,
        token: string, ledger: string, state: string, observedAt: number, operation: Pick<ContinuityOperation, 'id' | 'requestDigest'>): string {
        const data = { version: 1, sequence, previousGeneration, previousDigest, token, ledgerDigest: ledger, stateDigest: state, observedAt,
            operationId: operation.id, requestDigest: operation.requestDigest };
        const mac = createHmac('sha256', key).update('ludolume-child-head-v1\0').update(name).update(JSON.stringify(data)).digest('hex');
        return JSON.stringify({ ...data, mac });
    }
    function decode(name: string, value: HeadRead): (ContinuityHead & { operationId: string; requestDigest: string }) | null {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContinuityHeadUnavailableError();
        if (value.kind === 'absent') {
            if (Object.keys(value).sort().join(',') !== 'historyEmpty,kind' || value.historyEmpty !== true) throw new ContinuityHeadUnavailableError();
            return null;
        }
        if (value.kind !== 'found' || Object.keys(value).sort().join(',') !== 'body,generation,kind,live,name'
            || value.name !== name || value.live !== true || typeof value.generation !== 'string' || !GEN.test(value.generation)
            || typeof value.body !== 'string' || Buffer.byteLength(value.body, 'utf8') > 1500) throw new ContinuityHeadUnavailableError();
        let item: unknown;
        try { item = JSON.parse(value.body); } catch { throw new ContinuityHeadUnavailableError(); }
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ContinuityHeadUnavailableError();
        const v = item as Record<string, unknown>;
        if (Object.keys(v).sort().join(',') !== 'ledgerDigest,mac,observedAt,operationId,previousDigest,previousGeneration,requestDigest,sequence,stateDigest,token,version'
            || v.version !== 1 || !Number.isSafeInteger(v.sequence) || Number(v.sequence) < 1
            || typeof v.previousGeneration !== 'string' || !(v.previousGeneration === '0' || GEN.test(v.previousGeneration))
            || typeof v.previousDigest !== 'string' || !HEX.test(v.previousDigest)
            || typeof v.token !== 'string' || !HEX.test(v.token)
            || typeof v.ledgerDigest !== 'string' || !HEX.test(v.ledgerDigest)
            || typeof v.stateDigest !== 'string' || !HEX.test(v.stateDigest)
            || !Number.isSafeInteger(v.observedAt) || Number(v.observedAt) < 0
            || typeof v.operationId !== 'string' || !HEX.test(v.operationId)
            || typeof v.requestDigest !== 'string' || !HEX.test(v.requestDigest)
            || typeof v.mac !== 'string' || !HEX.test(v.mac)
            || (v.sequence === 1 && (v.previousGeneration !== '0' || v.previousDigest !== ZERO))
            || (Number(v.sequence) > 1 && (v.previousGeneration === '0' || v.previousDigest === ZERO))) throw new ContinuityHeadUnavailableError();
        const expected = bodyFor(name, Number(v.sequence), v.previousGeneration, v.previousDigest, v.token, v.ledgerDigest, v.stateDigest, Number(v.observedAt),
            { id: v.operationId, requestDigest: v.requestDigest });
        const mac = (JSON.parse(expected) as { mac: string }).mac;
        if (!timingSafeEqual(Buffer.from(v.mac, 'hex'), Buffer.from(mac, 'hex')) || expected !== value.body) throw new ContinuityHeadUnavailableError();
        return { sequence: Number(v.sequence), token: v.token, generation: value.generation,
            digest: createHash('sha256').update(value.body, 'utf8').digest('hex'), ledgerDigest: v.ledgerDigest, stateDigest: v.stateDigest,
            observedAt: Number(v.observedAt),
            operationId: v.operationId, requestDigest: v.requestDigest };
    }
    async function readStable(name: string) {
        const first = await bounded(signal => storage.read(name, signal));
        const fingerprint = JSON.stringify(first);
        decode(name, first);
        const second = await bounded(signal => storage.read(name, signal));
        if (fingerprint !== JSON.stringify(second)) throw new ContinuityHeadUnavailableError();
        return decode(name, second);
    }
    function match(expected: ContinuityHead, actual: ReturnType<typeof decode>): void {
        if (!expected || !Number.isSafeInteger(expected.sequence) || expected.sequence < 1
            || typeof expected.token !== 'string' || !HEX.test(expected.token)
            || typeof expected.digest !== 'string' || !HEX.test(expected.digest)
            || typeof expected.ledgerDigest !== 'string' || !HEX.test(expected.ledgerDigest)
            || typeof expected.stateDigest !== 'string' || !HEX.test(expected.stateDigest)
            || !Number.isSafeInteger(expected.observedAt) || expected.observedAt < 0
            || typeof expected.generation !== 'string' || !GEN.test(expected.generation)
            || !actual || expected.sequence !== actual.sequence || expected.token !== actual.token
            || expected.digest !== actual.digest || expected.generation !== actual.generation
            || expected.ledgerDigest !== actual.ledgerDigest || expected.stateDigest !== actual.stateDigest
            || expected.observedAt !== actual.observedAt) throw new ContinuityHeadUnavailableError();
    }
    async function write(name: string, childId: string, previous: ContinuityHead | null, operation: ContinuityOperation,
        rows: readonly ContinuityLedgerRow[], databaseNow: number, nextStateDigest: string): Promise<{ head: ContinuityHead; ledgerRows: readonly ContinuityLedgerRow[] }> {
        const sequence = previous ? previous.sequence + 1 : 1;
        if (!Number.isSafeInteger(sequence)) throw new ContinuityHeadUnavailableError();
        const token = randomBytes(32).toString('hex');
        // Rows are pruned only as part of this witnessed SQL transaction; at the
        // expiration instant a token is still valid, so retain the matching row.
        const retained = rows.filter(row => row.expiresAt >= databaseNow);
        const nextRows = [...retained, { childId, id: operation.id, requestDigest: operation.requestDigest,
            expiresAt: operation.expiresAt, sequence, token }];
        const nextLedgerDigest = ledgerDigest(childId, nextRows, sequence);
        const body = bodyFor(name, sequence, previous?.generation ?? '0', previous?.digest ?? ZERO, token, nextLedgerDigest, nextStateDigest, databaseNow, operation);
        const result = await bounded(signal => storage.replace(name, body, previous?.generation ?? '0', signal));
        const parsed = decode(name, result);
        if (!parsed || parsed.sequence !== sequence || parsed.token !== token || result.kind !== 'found'
            || result.body !== body || (generationScope === 'same-object' && previous !== null
                && result.generation === previous.generation)) throw new ContinuityHeadUnavailableError();
        const observed = await readStable(name);
        match(parsed, observed);
        return { head: { sequence: parsed.sequence, token: parsed.token, generation: parsed.generation,
            digest: parsed.digest, ledgerDigest: parsed.ledgerDigest, stateDigest: parsed.stateDigest,
            observedAt: parsed.observedAt }, ledgerRows: nextRows };
    }
    return Object.freeze({
        /** Authenticity and sequence only; this does not prove that the SQL state is current. */
        inspectArchivedEvent(childId: string, generation: string, body: string): Readonly<{ sequence: number; digest: string }> {
            try {
                const name = nameFor(childId);
                const value = decode(name, { kind: 'found', name, generation, body, live: true });
                if (!value) throw new Error();
                return { sequence: value.sequence, digest: value.digest };
            } catch { throw new ContinuityHeadUnavailableError(); }
        },
        /** databaseNow must be read from the pinned primary, under the same transaction and lock. */
        issueOperation(childId: string, canonicalRequest: Buffer, databaseNow: number): ContinuityOperation {
            nameFor(childId);
            if (!Number.isSafeInteger(databaseNow) || databaseNow < 0 || !Number.isSafeInteger(databaseNow + replayWindowMs)) {
                throw new TypeError('Invalid operation input.');
            }
            const requestDigest = digestRequest(childId, canonicalRequest);
            const unsigned = { id: randomBytes(32).toString('hex'), requestDigest, issuedAt: databaseNow,
                expiresAt: databaseNow + replayWindowMs };
            return { ...unsigned, mac: operationMac(childId, unsigned) };
        },
        /** Only after proving a NEW child under the same SQL lock and transaction. */
        async initializeNew(childId: string, operation: ContinuityOperation, databaseNow: number,
            canonicalRequest: Buffer, canonicalNewState: Buffer): Promise<Readonly<{
            head: ContinuityHead; ledgerRows: readonly ContinuityLedgerRow[] }>> {
            const name = nameFor(childId); const input = Object.freeze({ ...operation });
            validateOperation(childId, input, databaseNow, canonicalRequest);
            const newStateDigest = digestState(childId, canonicalNewState);
            try { if (await readStable(name) !== null) throw new ContinuityHeadUnavailableError();
                return await write(name, childId, null, input, [], databaseNow, newStateDigest); }
            catch { throw new ContinuityHeadUnavailableError(); }
        },
        async verifyExisting(childId: string, sql: ContinuityHead, rows: readonly ContinuityLedgerRow[], canonicalState: Buffer,
            databaseNow: number): Promise<void> {
            const name = nameFor(childId);
            try { const state = { ...sql }; const ledger = rows.map(row => ({ ...row }));
                const actualStateDigest = digestState(childId, canonicalState);
                match(state, await readStable(name));
                if (ledgerDigest(childId, ledger, state.sequence) !== state.ledgerDigest
                    || actualStateDigest !== state.stateDigest || !Number.isSafeInteger(databaseNow)
                    || databaseNow < state.observedAt) throw new ContinuityHeadUnavailableError();
            } catch { throw new ContinuityHeadUnavailableError(); }
        },
        /**
         * The COMPLETE ledger inventory must be read under the transaction and
         * lock, retained through the replay window, and bind child/id/payload.
         * databaseNow must come from the locked primary SQL server. A partial
         * ledger restore or unrecorded deletion changes the authenticated digest.
         * A newly returned head is NOT committed; caller must mutate SQL and
         * replace the ledger with returned rows, re-read the actual child state
         * and call verifyExisting with that state inside the same SQL transaction
         * before committing and acknowledging success.
         */
        async prepareExisting(childId: string, sql: ContinuityHead, operation: ContinuityOperation,
            rows: readonly ContinuityLedgerRow[], databaseNow: number, canonicalRequest: Buffer,
            canonicalCurrentState: Buffer, canonicalNextState: Buffer): Promise<Readonly<{ status: 'already-committed'; sequence: number }>
                | Readonly<{ status: 'prepared'; head: ContinuityHead; ledgerRows: readonly ContinuityLedgerRow[] }>> {
            const name = nameFor(childId); const input = Object.freeze({ ...operation });
            validateOperation(childId, input, databaseNow, canonicalRequest);
            const currentStateDigest = digestState(childId, canonicalCurrentState);
            const nextStateDigest = digestState(childId, canonicalNextState);
            try {
                const state = Object.freeze({ ...sql }); const ledger = rows.map(row => Object.freeze({ ...row }));
                const current = await readStable(name); match(state, current);
                if (ledgerDigest(childId, ledger, state.sequence) !== state.ledgerDigest
                    || currentStateDigest !== state.stateDigest || databaseNow < state.observedAt) throw new ContinuityHeadUnavailableError();
                const previous = ledger.find(row => row.id === input.id);
                if (previous) {
                    if (previous.requestDigest !== input.requestDigest || previous.expiresAt !== input.expiresAt
                        || (previous.sequence === state.sequence && (previous.token !== state.token
                            || current?.operationId !== previous.id || current.requestDigest !== previous.requestDigest))) {
                        throw new ContinuityHeadUnavailableError();
                    }
                    return { status: 'already-committed', sequence: previous.sequence };
                }
                if (current?.operationId === input.id) throw new ContinuityHeadUnavailableError();
                return { status: 'prepared', ...await write(name, childId, state, input, ledger, databaseNow, nextStateDigest) };
            } catch { throw new ContinuityHeadUnavailableError(); }
        },
    });
}
