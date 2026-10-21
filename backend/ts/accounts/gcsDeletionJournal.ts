import { createHash, randomUUID } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import {
    AccountDeletionJournal, assertAccountId, DeletionIntent, DeletionJournalReader,
    DeletionJournalSnapshot, parseDeletionIntent,
} from './deletionJournal';

export const DELETION_JOURNAL_BUCKET = 'ludolume-deletion-journal-1012884798546';
const STORAGE_API = 'https://storage.googleapis.com';
const OBJECT_PATH = `/storage/v1/b/${DELETION_JOURNAL_BUCKET}/o`;
const REQUEST_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 60_000;
const MAX_JOURNAL_OBJECTS = 10_000;
const MAX_INTENT_BYTES = 512;
const OBJECT_NAME = /^v1\/intents\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const OBJECT_FIELDS = 'bucket,name,generation,size,md5Hash,timeDeleted,softDeleteTime';

export interface JournalHttpRequest {
    url: string;
    method: 'GET' | 'POST';
    params: Record<string, string | number | boolean>;
    headers?: Record<string, string>;
    data?: string;
    responseType: 'json' | 'text';
    retry: false;
    timeout: number;
    maxContentLength: number;
    maxRedirects: 0;
    signal: AbortSignal;
}

export interface JournalHttpClient {
    request(options: JournalHttpRequest): Promise<{ status: number; data: unknown }>;
}

interface JournalOptions {
    bucket?: string;
    client?: JournalHttpClient;
    now?: () => Date;
    requestId?: () => string;
    timeoutMs?: number;
    readTimeoutMs?: number;
}

interface JournalObject {
    name: string;
    generation: string;
    size: number;
    md5Hash: string;
}

/** Request creation failures are intentionally indistinguishable from lost acknowledgements. */
export class DeletionJournalUnavailableError extends Error {
    constructor() {
        super('Deletion journal unavailable; the operation could not be confirmed');
        this.name = 'DeletionJournalUnavailableError';
    }
}

export function createGcsDeletionJournal(
    options: JournalOptions = {},
): AccountDeletionJournal & DeletionJournalReader {
    if (options.bucket !== undefined && options.bucket !== DELETION_JOURNAL_BUCKET) {
        throw new Error('Unapproved deletion journal bucket');
    }
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > REQUEST_TIMEOUT_MS) {
        throw new Error('Invalid deletion journal timeout');
    }
    const readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
    if (!Number.isInteger(readTimeoutMs) || readTimeoutMs < 1 || readTimeoutMs > 300_000) {
        throw new Error('Invalid deletion journal read timeout');
    }
    const client = options.client ?? createAuthenticatedClient();

    async function request(
        input: Pick<JournalHttpRequest, 'url' | 'method' | 'params' | 'responseType'>
            & Partial<Pick<JournalHttpRequest, 'headers' | 'data'>>,
        readDeadline?: number,
    ): Promise<unknown> {
        const remainingMs = readDeadline === undefined ? timeoutMs : Math.min(timeoutMs, readDeadline - Date.now());
        if (remainingMs <= 0) throw new DeletionJournalUnavailableError();
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const deadline = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(new DeletionJournalUnavailableError());
                }, remainingMs);
            });
            const response = await Promise.race([client.request({
                ...input, retry: false, timeout: remainingMs, maxRedirects: 0,
                maxContentLength: 256 * 1024, signal: controller.signal,
            }), deadline]);
            if (response.status !== 200) throw new DeletionJournalUnavailableError();
            return response.data;
        } catch {
            // SDK errors can contain bearer headers, request bodies and account identifiers.
            throw new DeletionJournalUnavailableError();
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }

    async function recordIntent(accountId: string, action: DeletionIntent['action']): Promise<void> {
        assertAccountId(accountId);
        const intent = parseDeletionIntent({
            version: 1, accountId, action,
            requestedAt: (options.now ?? (() => new Date()))().toISOString(),
        });
        const name = `v1/intents/${(options.requestId ?? randomUUID)()}.json`;
        if (!OBJECT_NAME.test(name)) throw new Error('Invalid deletion request identity');
        const data = JSON.stringify(intent);
        try {
            const response = await request({
                method: 'POST', url: `${STORAGE_API}/upload${OBJECT_PATH}`,
                params: { uploadType: 'media', name, ifGenerationMatch: 0, fields: OBJECT_FIELDS },
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                data, responseType: 'json',
            });
            const saved = parseJournalObject(response);
            if (saved.name !== name || saved.size !== Buffer.byteLength(data)
                || saved.md5Hash !== checksum(data)) throw new DeletionJournalUnavailableError();
            // A 412 is never success: the create-only identity cannot inspect a conflicting object.
        } catch {
            throw new DeletionJournalUnavailableError();
        }
    }

    async function listObjects(softDeleted: boolean, readDeadline: number): Promise<JournalObject[]> {
        const result: JournalObject[] = [];
        const tokens = new Set<string>();
        const names = new Set<string>();
        let pageToken: string | undefined;
        do {
            const response = await request({
                method: 'GET', url: `${STORAGE_API}${OBJECT_PATH}`, responseType: 'json',
                params: {
                    ...(softDeleted ? { softDeleted: true } : { versions: true }),
                    maxResults: 100, fields: `kind,nextPageToken,items(${OBJECT_FIELDS})`,
                    ...(pageToken === undefined ? {} : { pageToken }),
                },
            }, readDeadline);
            const page = parseObject(response);
            if (page.kind !== 'storage#objects' || page.prefixes !== undefined
                || (page.items !== undefined && !Array.isArray(page.items))) {
                throw new DeletionJournalUnavailableError();
            }
            const items = (page.items ?? []) as unknown[];
            if (items.length > 100 || result.length + items.length > MAX_JOURNAL_OBJECTS) {
                throw new DeletionJournalUnavailableError();
            }
            if (softDeleted && items.length !== 0) throw new DeletionJournalUnavailableError();
            for (const item of items) {
                const object = parseJournalObject(item);
                if (names.has(object.name)) throw new DeletionJournalUnavailableError();
                names.add(object.name);
                result.push(object);
            }
            pageToken = parsePageToken(page.nextPageToken);
            if (pageToken !== undefined && tokens.has(pageToken)) throw new DeletionJournalUnavailableError();
            if (pageToken !== undefined) tokens.add(pageToken);
            if (tokens.size > MAX_JOURNAL_OBJECTS) throw new DeletionJournalUnavailableError();
        } while (pageToken !== undefined);
        return result;
    }

    async function readDeletionIntents(): Promise<DeletionJournalSnapshot> {
        try {
            const readDeadline = Date.now() + readTimeoutMs;
            await listObjects(true, readDeadline);
            const objects = await listObjects(false, readDeadline);
            const intents: DeletionIntent[] = [];
            for (const object of objects) {
                const body = await request({
                    method: 'GET',
                    url: `${STORAGE_API}${OBJECT_PATH}/${encodeURIComponent(object.name)}`,
                    params: { alt: 'media', generation: object.generation, ifGenerationMatch: object.generation },
                    responseType: 'text',
                }, readDeadline);
                if (typeof body !== 'string' || Buffer.byteLength(body) !== object.size
                    || checksum(body) !== object.md5Hash) throw new DeletionJournalUnavailableError();
                intents.push(parseDeletionIntent(JSON.parse(body)));
            }
            await listObjects(true, readDeadline);
            // Listing is not a snapshot: callers must drain source writers and compare fresh
            // digests around replay. Never use this result as a permanent recovery export.
            const inventory = objects.map(({ name, generation }) => [name, generation])
                .sort(([left], [right]) => left.localeCompare(right));
            return { intents, digest: createHash('sha256').update(JSON.stringify(inventory)).digest('hex') };
        } catch {
            throw new DeletionJournalUnavailableError();
        }
    }

    return { recordAccountDeletion: accountId => recordIntent(accountId, 'delete-account'),
        recordPublicScoreWithdrawal: accountId => recordIntent(accountId, 'withdraw-public-scores'), readDeletionIntents };
}

function createAuthenticatedClient(): JournalHttpClient {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.read_write'] });
    return {
        async request(options) {
            const client = await auth.getClient();
            const headers = await client.getRequestHeaders(options.url);
            // ADC discovery may outlast the deadline; it must not then send a late mutation.
            options.signal.throwIfAborted();
            for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
            // Authenticate before the one HTTP attempt. AuthClient.request can replay a
            // mutation after an authentication failure even when transport retries are off.
            const response = await client.transporter.request({ ...options, headers });
            return { status: response.status, data: response.data };
        },
    };
}

function parseJournalObject(value: unknown): JournalObject {
    const object = parseObject(value);
    if (object.bucket !== DELETION_JOURNAL_BUCKET
        || typeof object.name !== 'string' || !OBJECT_NAME.test(object.name)
        || typeof object.generation !== 'string' || !/^[1-9][0-9]*$/.test(object.generation)
        || typeof object.size !== 'string' || !/^[1-9][0-9]*$/.test(object.size)
        || Number(object.size) > MAX_INTENT_BYTES
        || typeof object.md5Hash !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(object.md5Hash)
        || object.timeDeleted !== undefined || object.softDeleteTime !== undefined) {
        throw new DeletionJournalUnavailableError();
    }
    return { name: object.name, generation: object.generation, size: Number(object.size), md5Hash: object.md5Hash };
}

function parseObject(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new DeletionJournalUnavailableError();
    }
    return value as Record<string, unknown>;
}

function parsePageToken(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
        throw new DeletionJournalUnavailableError();
    }
    return value;
}

function checksum(body: string): string {
    return createHash('md5').update(body).digest('base64');
}
