import { createHash } from 'node:crypto';
import { createContinuityHead, ContinuityHeadUnavailableError, type ContinuityHeadStorage } from './childContinuityHead';

const GEN = /^[1-9][0-9]{0,19}$/u;
const HEAD_NAME = /^v1\/heads\/([a-f0-9]{64})\.json$/u;
const MAX_SEQUENCE = 999_999_999_999;
const MD5 = /^[A-Za-z0-9+/]{22}==$/u;
const LIST_FIELDS = 'kind,nextPageToken,items(bucket,name,generation,size,md5Hash,timeDeleted,softDeleteTime)';

type Metadata = Readonly<{ bucket: string; name: string; generation: string; size: string; md5Hash: string;
    timeDeleted?: unknown; softDeleteTime?: unknown }>;
type Page = Readonly<{ kind: string; items?: readonly Metadata[]; nextPageToken?: string }>;
/**
 * A deliberately narrow transport contract, NOT a production GCS client. The
 * transport must use the JSON API as specified, disable caches and automatic
 * retries, honor AbortSignal, and return fresh provider responses. It must not
 * synthesize absence or completeness from errors or inaccessible metadata.
 */
export type AppendOnlyObjectTransport = Readonly<{
    list(input: Readonly<{ bucket: string; prefix: string; startOffset: string; maxResults: 2; fields: string;
        versions?: true; softDeleted?: true; signal: AbortSignal }>): Promise<Page>;
    readBody(input: Readonly<{ bucket: string; name: string; generation: string;
        ifGenerationMatch: string; signal: AbortSignal }>): Promise<string>;
    createOnly(input: Readonly<{ bucket: string; name: string; body: string;
        ifGenerationMatch: '0'; signal: AbortSignal }>): Promise<Metadata>;
}>;

/**
 * Open one disposable adapter per locked SQL transaction. SQL's sequence and
 * generation are snapshots, not caller-provided request values. On uncertain
 * write or SQL commit, discard it and reconcile; never silently reconnect.
 * Every relevant writer MUST hold the same child lock until SQL commit.
 */
export function openAppendOnlyContinuitySession(options: Readonly<{
    transport: AppendOnlyObjectTransport; bucket: string; expectedBucket: string; key: Buffer;
    sequence: number; generation: string; timeoutMs?: number;
}>) {
    const { transport, bucket, expectedBucket } = options;
    if (!transport || typeof transport.list !== 'function' || typeof transport.readBody !== 'function'
        || typeof transport.createOnly !== 'function' || typeof bucket !== 'string' || bucket !== expectedBucket
        || bucket.length < 3 || bucket.length > 63 || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(bucket)
        || bucket.includes('..') || /^\d+\.\d+\.\d+\.\d+$/u.test(bucket)
        || !Number.isSafeInteger(options.sequence) || options.sequence < 0 || options.sequence > MAX_SEQUENCE
        || typeof options.generation !== 'string'
        || (options.sequence === 0 ? options.generation !== '0' : !GEN.test(options.generation))) {
        throw new TypeError('Invalid append-only continuity configuration.');
    }
    let sequence = options.sequence;
    let generation = options.generation;
    let boundName: string | undefined;
    let poisoned = false;
    function checkUsable(signal: AbortSignal): void {
        if (poisoned || signal.aborted) { poisoned = true; throw new Error('Continuity session is uncertain.'); }
    }
    async function guarded<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
        checkUsable(signal);
        const onAbort = () => { poisoned = true; };
        signal.addEventListener('abort', onAbort, { once: true });
        try { const result = await operation(); checkUsable(signal); return result; }
        catch (error) { poisoned = true; throw error; }
        finally { signal.removeEventListener('abort', onAbort); }
    }
    function prefixFor(name: string): string {
        if (typeof name !== 'string') throw new Error('Invalid continuity head.');
        const match = HEAD_NAME.exec(name);
        if (!match) throw new Error('Invalid continuity head.');
        if (boundName !== undefined && boundName !== name) throw new Error('Continuity session belongs to another child.');
        boundName = name;
        return `v1/events/${match[1]}/`;
    }
    function eventName(prefix: string, value: number): string {
        if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SEQUENCE) throw new Error('Invalid event sequence.');
        return `${prefix}${String(value).padStart(12, '0')}.json`;
    }
    function validPage(page: Page): readonly Metadata[] {
        if (!page || typeof page !== 'object' || Array.isArray(page) || page.kind !== 'storage#objects'
            || Object.keys(page).some(key => !['kind', 'items', 'nextPageToken'].includes(key))
            || page.nextPageToken !== undefined || (page.items !== undefined && !Array.isArray(page.items))
            || (page.items?.length ?? 0) > 2) throw new Error('Incomplete continuity inventory.');
        return page.items ?? [];
    }
    function metadata(item: Metadata, name: string): Metadata {
        if (!item || typeof item !== 'object' || Array.isArray(item) || item.bucket !== bucket || item.name !== name
            || Object.keys(item).some(key => !['bucket', 'name', 'generation', 'size', 'md5Hash', 'timeDeleted', 'softDeleteTime'].includes(key))
            || typeof item.generation !== 'string' || !GEN.test(item.generation)
            || typeof item.size !== 'string' || !/^[1-9][0-9]{0,3}$/u.test(item.size) || Number(item.size) > 1500
            || typeof item.md5Hash !== 'string' || !MD5.test(item.md5Hash)
            || Object.prototype.hasOwnProperty.call(item, 'timeDeleted')
            || Object.prototype.hasOwnProperty.call(item, 'softDeleteTime')) throw new Error('Invalid continuity metadata.');
        return item;
    }
    function checkBody(item: Metadata, body: unknown): asserts body is string {
        if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') !== Number(item.size)
            || createHash('md5').update(body, 'utf8').digest('base64') !== item.md5Hash) throw new Error('Invalid continuity body.');
    }
    const storage: ContinuityHeadStorage = {
        async read(name, signal) {
            return guarded(signal, async () => {
            const prefix = prefixFor(name);
            const startOffset = sequence === 0 ? prefix : eventName(prefix, sequence);
            // The inclusive lower bound catches the current event and every
            // lexically later name, without scanning earlier history.
            const versions = validPage(await transport.list({ bucket, prefix, startOffset, maxResults: 2,
                fields: LIST_FIELDS, versions: true, signal }));
            const softDeleted = validPage(await transport.list({ bucket, prefix, startOffset, maxResults: 2,
                fields: LIST_FIELDS, softDeleted: true, signal }));
            checkUsable(signal);
            if (softDeleted.length !== 0) throw new Error('Soft-deleted continuity evidence.');
            if (sequence === 0) {
                if (versions.length !== 0) throw new Error('Existing continuity evidence.');
                return { kind: 'absent', historyEmpty: true };
            }
            if (versions.length !== 1) throw new Error('Missing, duplicate or later continuity evidence.');
            const event = metadata(versions[0], eventName(prefix, sequence));
            if (event.generation !== generation) throw new Error('Continuity generation changed.');
            const body = await transport.readBody({ bucket, name: event.name, generation: event.generation,
                ifGenerationMatch: event.generation, signal });
            checkBody(event, body);
            return { kind: 'found', name, generation: event.generation, body, live: true };
            });
        },
        async replace(name, body, expectedGeneration, signal) {
            return guarded(signal, async () => {
            const prefix = prefixFor(name);
            if (expectedGeneration !== generation || sequence >= MAX_SEQUENCE) throw new Error('Continuity predecessor changed.');
            let decoded: unknown;
            try { decoded = JSON.parse(body); } catch { throw new Error('Invalid continuity write.'); }
            if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)
                || (decoded as Record<string, unknown>).sequence !== sequence + 1
                || (decoded as Record<string, unknown>).previousGeneration !== expectedGeneration) throw new Error('Invalid continuity write.');
            const nextName = eventName(prefix, sequence + 1);
            const result = metadata(await transport.createOnly({ bucket, name: nextName, body, ifGenerationMatch: '0', signal }), nextName);
            checkUsable(signal);
            checkBody(result, body);
            // Only a fully confirmed response advances this disposable session.
            // A lost response leaves SQL behind and is reconciled separately.
            sequence++; generation = result.generation;
            return { kind: 'found', name, generation, body, live: true };
            });
        },
    };
    // Unlike replacement of one head object, distinct event objects can have
    // unrelated or even equal generation numbers. Sequence + name remain bound.
    const head = createContinuityHead(storage, options.key, options.timeoutMs, 'distinct-objects');
    let inFlight = false;
    async function use<T>(operation: () => Promise<T>): Promise<T> {
        if (poisoned || inFlight) { poisoned = true; throw new ContinuityHeadUnavailableError(); }
        inFlight = true;
        try {
            const result = await operation();
            if (poisoned) throw new ContinuityHeadUnavailableError();
            return result;
        } catch (error) { poisoned = true; throw error; }
        finally { inFlight = false; }
    }
    return Object.freeze({
        issueOperation(...args: Parameters<typeof head.issueOperation>) {
            if (poisoned) throw new ContinuityHeadUnavailableError();
            return head.issueOperation(...args);
        },
        initializeNew(...args: Parameters<typeof head.initializeNew>) { return use(() => head.initializeNew(...args)); },
        verifyExisting(...args: Parameters<typeof head.verifyExisting>) { return use(() => head.verifyExisting(...args)); },
        prepareExisting(...args: Parameters<typeof head.prepareExisting>) { return use(() => head.prepareExisting(...args)); },
    });
}
