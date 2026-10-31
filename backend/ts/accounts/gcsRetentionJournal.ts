import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { isAccountId } from './deletionJournal';
import { DELETION_JOURNAL_BUCKET, type JournalHttpClient, type JournalHttpRequest } from './gcsDeletionJournal';
import { parseInactivityInstant } from './childInactivityPolicy';
import type { RetentionIntent, RetentionJournal } from './childInactivityWorkflow';

const API = 'https://storage.googleapis.com';
const LIMIT = 10_000;
const READ_LIMIT = 60_000;
const MAX_BODY = 2048;
const MAX_OBJECTS = 10_000;
const NAME = /^v1\/conditional\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/u;
const HEX = /^[a-f0-9]{64}$/u;

/** An unconfirmed write may have succeeded. Never retry or replay it automatically. */
export class RetentionJournalUnavailableError extends Error {
    constructor() { super('Retention intent journal unavailable or unconfirmed. Reconcile before retrying.'); }
}

type Options = Readonly<{
    bucket: string;
    expectedBucket: string;
    key: Buffer;
    /** Must establish live-primary health independently. Restores and uncertainty return false. */
    verifyActivityContinuity: (intent: RetentionIntent) => Promise<boolean>;
    client?: JournalHttpClient;
    timeoutMs?: number;
}>;
type ObjectInfo = Readonly<{ name: string; generation: string; size: number; md5: string }>;
export type RestoreGuard = Readonly<{ state: 'active' | 'hold'; database: string; serverUuid: string;
    epoch: string; expiresAt: string }>;
export type ObservedRestoreGuard = RestoreGuard & Readonly<{ generation: string }>;
export type RetentionResolution = Readonly<{ outcome: 'kept' | 'deleted'; confirmedAt: string;
    observedActivityAt: string | null; proofDigest: string }>;

/**
 * Conditional intents have a separate bucket and HMAC key from the unconditional
 * deletion journal. A readable intent is NOT permission to replay a deletion.
 */
export function createGcsRetentionJournal(options: Options): RetentionJournal & {
    readIntents(): Promise<readonly RetentionIntent[]>;
    readIntentsForChild(childId: string): Promise<readonly RetentionIntent[]>;
    readRestoreGuard(): Promise<ObservedRestoreGuard>;
    writeRestoreGuard(guard: RestoreGuard, expectedGeneration: string): Promise<string>;
    readResolution(intent: RetentionIntent): Promise<RetentionResolution | null>;
    recordResolution(intent: RetentionIntent, resolution: RetentionResolution): Promise<void>;
} {
    const { bucket, expectedBucket, verifyActivityContinuity } = options;
    if (typeof bucket !== 'string' || bucket !== expectedBucket || bucket === DELETION_JOURNAL_BUCKET
        || bucket.length < 3 || bucket.length > 63 || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(bucket)
        || bucket.includes('..') || /^\d+\.\d+\.\d+\.\d+$/u.test(bucket)
        || !Buffer.isBuffer(options.key) || options.key.length < 32
        || typeof verifyActivityContinuity !== 'function') throw new TypeError('Invalid retention journal configuration.');
    const timeout = options.timeoutMs ?? LIMIT;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > LIMIT) throw new TypeError('Invalid retention journal timeout.');
    const key = Buffer.from(options.key);
    const client = options.client ?? authenticatedClient();
    const base = `${API}/storage/v1/b/${bucket}/o`;

    async function request(input: Pick<JournalHttpRequest, 'url' | 'method' | 'params' | 'responseType'>
        & Partial<Pick<JournalHttpRequest, 'headers' | 'data'>>, deadlineMs?: number): Promise<unknown> {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const remaining = deadlineMs === undefined ? timeout : Math.min(timeout, deadlineMs - Date.now());
            if (remaining <= 0) throw new RetentionJournalUnavailableError();
            const deadline = new Promise<never>((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new RetentionJournalUnavailableError()); }, remaining);
            });
            const response = await Promise.race([client.request({ ...input, retry: false, timeout: remaining,
                maxContentLength: 256 * 1024, maxRedirects: 0, signal: controller.signal }), deadline]);
            if (response.status !== 200) throw new RetentionJournalUnavailableError();
            return response.data;
        } catch { throw new RetentionJournalUnavailableError(); }
        finally { if (timer !== undefined) clearTimeout(timer); }
    }

    function childPrefix(childId: string): string {
        if (!isAccountId(childId)) throw new TypeError('Invalid child identity.');
        const tag = createHmac('sha256', key).update('ludolume-retention-child-v1\0').update(childId).digest('hex');
        return `v1/conditional/${tag}/`;
    }
    function signed(intent: RetentionIntent): { name: string; body: string } {
        const normalized = validateIntent(intent);
        const payload = JSON.stringify(normalized);
        const mac = createHmac('sha256', key).update('ludolume-conditional-retention-v1\0').update(payload).digest('hex');
        return { name: `${childPrefix(normalized.childId)}${mac}.json`, body: JSON.stringify({ version: 1, intent: normalized, mac }) };
    }
    function signedResolution(intent: RetentionIntent, resolution: RetentionResolution): { name: string; body: string } {
        const original = signed(intent);
        const normalized = validateResolution(resolution);
        if (normalized.confirmedAt < intent.deliveredAt || (normalized.outcome === 'kept'
            && (!normalized.observedActivityAt || normalized.observedActivityAt <= intent.activityAt
                || normalized.observedActivityAt > normalized.confirmedAt))) throw new TypeError('Invalid retention resolution chronology.');
        const originalId = original.name.slice(original.name.lastIndexOf('/') + 1, -'.json'.length);
        const payload = JSON.stringify({ intentId: originalId, resolution: normalized });
        const mac = createHmac('sha256', key).update('ludolume-retention-resolution-v1\0').update(payload).digest('hex');
        return { name: original.name.replace('v1/conditional/', 'v1/resolutions/'),
            body: JSON.stringify({ version: 1, intentId: originalId, resolution: normalized, mac }) };
    }
    function info(input: unknown, expectedName?: string): ObjectInfo {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RetentionJournalUnavailableError();
        const v = input as Record<string, unknown>;
        if (v.bucket !== bucket || typeof v.name !== 'string' || !(expectedName ? v.name === expectedName : NAME.test(v.name))
            || typeof v.generation !== 'string' || !/^[1-9][0-9]*$/u.test(v.generation)
            || typeof v.size !== 'string' || !/^[1-9][0-9]*$/u.test(v.size) || Number(v.size) > MAX_BODY
            || typeof v.md5Hash !== 'string' || !/^[A-Za-z0-9+/]{22}==$/u.test(v.md5Hash)
            || v.timeDeleted !== undefined || v.softDeleteTime !== undefined) throw new RetentionJournalUnavailableError();
        return { name: v.name, generation: v.generation, size: Number(v.size), md5: v.md5Hash };
    }
    const fields = 'bucket,name,generation,size,md5Hash,timeDeleted,softDeleteTime';
    const guardName = 'v1/control/restore-guard.json';
    function signedGuard(guard: RestoreGuard): string {
        const normalized = validateGuard(guard);
        const payload = JSON.stringify(normalized);
        const mac = createHmac('sha256', key).update('ludolume-retention-restore-guard-v1\0').update(payload).digest('hex');
        return JSON.stringify({ version: 1, guard: normalized, mac });
    }
    async function readRestoreGuard(): Promise<ObservedRestoreGuard> {
        const object = info(await request({ method: 'GET', url: `${base}/${encodeURIComponent(guardName)}`,
            params: { fields }, responseType: 'json' }), guardName);
        const body = await request({ method: 'GET', url: `${base}/${encodeURIComponent(guardName)}`,
            params: { alt: 'media', generation: object.generation, ifGenerationMatch: object.generation }, responseType: 'text' });
        if (typeof body !== 'string' || Buffer.byteLength(body) !== object.size
            || createHash('md5').update(body).digest('base64') !== object.md5) throw new RetentionJournalUnavailableError();
        let decoded: Record<string, unknown>;
        try { decoded = JSON.parse(body) as Record<string, unknown>; } catch { throw new RetentionJournalUnavailableError(); }
        if (!decoded || Object.keys(decoded).sort().join(',') !== 'guard,mac,version'
            || decoded.version !== 1 || typeof decoded.mac !== 'string' || !HEX.test(decoded.mac)) throw new RetentionJournalUnavailableError();
        const guard = validateGuard(decoded.guard);
        const expected = signedGuard(guard);
        if (expected !== body) throw new RetentionJournalUnavailableError();
        return { ...guard, generation: object.generation };
    }
    async function writeRestoreGuard(guard: RestoreGuard, expectedGeneration: string): Promise<string> {
        // A caller must first know the exact current generation, or use zero only for first creation.
        if (!/^(?:0|[1-9][0-9]*)$/u.test(expectedGeneration)) throw new TypeError('Invalid restore guard generation.');
        if (expectedGeneration === '0') {
            const value = await request({ method: 'GET', url: base, responseType: 'json',
                params: { prefix: guardName, softDeleted: true, maxResults: 1, fields: 'kind,nextPageToken,items(name)' } });
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RetentionJournalUnavailableError();
            const page = value as Record<string, unknown>;
            if (page.kind !== 'storage#objects' || page.nextPageToken !== undefined
                || (page.items !== undefined && (!Array.isArray(page.items) || page.items.length !== 0))) {
                throw new RetentionJournalUnavailableError();
            }
        }
        const body = signedGuard(guard);
        const object = info(await request({ method: 'POST', url: `${API}/upload/storage/v1/b/${bucket}/o`,
            params: { uploadType: 'media', name: guardName, ifGenerationMatch: expectedGeneration, fields },
            headers: { 'Content-Type': 'application/json; charset=utf-8' }, data: body, responseType: 'json' }), guardName);
        if (object.size !== Buffer.byteLength(body) || object.md5 !== createHash('md5').update(body).digest('base64')) {
            throw new RetentionJournalUnavailableError();
        }
        return object.generation;
    }
    async function read(object: ObjectInfo, deadline?: number): Promise<RetentionIntent> {
        const body = await request({ method: 'GET', url: `${base}/${encodeURIComponent(object.name)}`,
            params: { alt: 'media', generation: object.generation, ifGenerationMatch: object.generation }, responseType: 'text' }, deadline);
        if (typeof body !== 'string' || Buffer.byteLength(body) !== object.size
            || createHash('md5').update(body).digest('base64') !== object.md5) throw new RetentionJournalUnavailableError();
        let decoded: Record<string, unknown>;
        try { decoded = JSON.parse(body) as Record<string, unknown>; } catch { throw new RetentionJournalUnavailableError(); }
        if (!decoded || Object.keys(decoded).sort().join(',') !== 'intent,mac,version'
            || decoded.version !== 1 || typeof decoded.mac !== 'string' || !HEX.test(decoded.mac)) throw new RetentionJournalUnavailableError();
        const intent = validateIntent(decoded.intent);
        const expected = signed(intent);
        const expectedMac = expected.name.slice(expected.name.lastIndexOf('/') + 1, -'.json'.length);
        if (object.name !== expected.name || expected.body !== body
            || !timingSafeEqual(Buffer.from(decoded.mac, 'hex'), Buffer.from(expectedMac, 'hex'))) throw new RetentionJournalUnavailableError();
        return intent;
    }
    async function recordRetentionIntent(intent: RetentionIntent): Promise<void> {
        const entry = signed(intent);
        const response = await request({ method: 'POST', url: `${API}/upload/storage/v1/b/${bucket}/o`,
            params: { uploadType: 'media', name: entry.name, ifGenerationMatch: 0, fields },
            headers: { 'Content-Type': 'application/json; charset=utf-8' }, data: entry.body, responseType: 'json' });
        const object = info(response);
        if (object.name !== entry.name || object.size !== Buffer.byteLength(entry.body)
            || object.md5 !== createHash('md5').update(entry.body).digest('base64')) throw new RetentionJournalUnavailableError();
    }
    async function verifyRetentionIntent(intent: RetentionIntent): Promise<boolean> {
        const entry = signed(intent);
        const object = info(await request({ method: 'GET', url: `${base}/${encodeURIComponent(entry.name)}`,
            params: { fields }, responseType: 'json' }));
        if (object.name !== entry.name) throw new RetentionJournalUnavailableError();
        return signed(await read(object)).body === entry.body;
    }
    async function readResolution(intent: RetentionIntent): Promise<RetentionResolution | null> {
        const name = signedResolution(intent, { outcome: 'deleted', confirmedAt: intent.deliveredAt,
            observedActivityAt: null, proofDigest: intent.receiptDigest }).name;
        try {
            const object = info(await request({ method: 'GET', url: `${base}/${encodeURIComponent(name)}`,
                params: { fields }, responseType: 'json' }), name);
            const body = await request({ method: 'GET', url: `${base}/${encodeURIComponent(name)}`,
                params: { alt: 'media', generation: object.generation, ifGenerationMatch: object.generation }, responseType: 'text' });
            if (typeof body !== 'string' || Buffer.byteLength(body) !== object.size
                || createHash('md5').update(body).digest('base64') !== object.md5) return null;
            const decoded = JSON.parse(body) as Record<string, unknown>;
            if (!decoded || Object.keys(decoded).sort().join(',') !== 'intentId,mac,resolution,version'
                || decoded.version !== 1) return null;
            const resolution = validateResolution(decoded.resolution);
            return signedResolution(intent, resolution).body === body ? resolution : null;
        } catch { return null; }
    }
    /** Only a verified parent/administrator workflow may call this; records are append-only. */
    async function recordResolution(intent: RetentionIntent, resolution: RetentionResolution): Promise<void> {
        if (!await verifyRetentionIntent(intent)) throw new RetentionJournalUnavailableError();
        const entry = signedResolution(intent, resolution);
        const object = info(await request({ method: 'POST', url: `${API}/upload/storage/v1/b/${bucket}/o`,
            params: { uploadType: 'media', name: entry.name, ifGenerationMatch: 0, fields },
            headers: { 'Content-Type': 'application/json; charset=utf-8' }, data: entry.body, responseType: 'json' }), entry.name);
        if (object.size !== Buffer.byteLength(entry.body) || object.md5 !== createHash('md5').update(entry.body).digest('base64')) {
            throw new RetentionJournalUnavailableError();
        }
    }
    async function listObjects(prefix: string, softDeleted: boolean, deadline: number): Promise<ObjectInfo[]> {
        const objects: ObjectInfo[] = []; const names = new Set<string>(); const tokens = new Set<string>();
        let pageToken: string | undefined;
        do {
            const value = await request({ method: 'GET', url: base, responseType: 'json',
                params: { prefix, ...(softDeleted ? { softDeleted: true } : { versions: true }), maxResults: 100,
                    fields: `kind,nextPageToken,items(${fields})`, ...(pageToken ? { pageToken } : {}) } }, deadline);
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RetentionJournalUnavailableError();
            const page = value as Record<string, unknown>;
            if (page.kind !== 'storage#objects' || (page.items !== undefined && !Array.isArray(page.items))
                || page.prefixes !== undefined) throw new RetentionJournalUnavailableError();
            const items = (page.items ?? []) as unknown[];
            if (items.length > 100 || objects.length + items.length > MAX_OBJECTS) throw new RetentionJournalUnavailableError();
            // A deleted intent could hide an uncertain deletion; require explicit reconciliation.
            if (softDeleted && items.length) throw new RetentionJournalUnavailableError();
            for (const item of items) {
                const object = info(item);
                if (!object.name.startsWith(prefix) || names.has(object.name)) throw new RetentionJournalUnavailableError();
                names.add(object.name); objects.push(object);
            }
            if (page.nextPageToken === undefined) pageToken = undefined;
            else {
                if (typeof page.nextPageToken !== 'string' || !page.nextPageToken || page.nextPageToken.length > 4096
                    || tokens.has(page.nextPageToken)) throw new RetentionJournalUnavailableError();
                pageToken = page.nextPageToken; tokens.add(pageToken);
                if (tokens.size > MAX_OBJECTS) throw new RetentionJournalUnavailableError();
            }
        } while (pageToken);
        return objects.sort((a, b) => a.name.localeCompare(b.name));
    }
    async function readInventory(prefix: string): Promise<readonly RetentionIntent[]> {
        const deadline = Date.now() + READ_LIMIT;
        await listObjects(prefix, true, deadline);
        const objects = await listObjects(prefix, false, deadline);
        const results: RetentionIntent[] = [];
        for (const object of objects) results.push(await read(object, deadline));
        await listObjects(prefix, true, deadline);
        const after = await listObjects(prefix, false, deadline);
        if (JSON.stringify(objects) !== JSON.stringify(after)) throw new RetentionJournalUnavailableError();
        // Even matching inventories are not a persistent fence. Recovery must stop
        // writers and repeat reconciliation before cutover; this is not replay authority.
        return Object.freeze(results);
    }
    return { recordRetentionIntent, verifyRetentionIntent, readResolution, recordResolution,
        readIntents: () => readInventory('v1/conditional/'),
        readIntentsForChild: async childId => readInventory(childPrefix(childId)),
        readRestoreGuard, writeRestoreGuard,
        async verifyActivityContinuity(intent) {
            validateIntent(intent);
            try { return await verifyActivityContinuity(intent) === true; } catch { return false; }
        } };
}

function validateResolution(input: unknown): RetentionResolution {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid retention resolution.');
    const v = input as Record<string, unknown>;
    if (Object.keys(v).sort().join(',') !== 'confirmedAt,observedActivityAt,outcome,proofDigest'
        || (v.outcome !== 'kept' && v.outcome !== 'deleted') || parseInactivityInstant(v.confirmedAt) === null
        || (v.outcome === 'kept' ? parseInactivityInstant(v.observedActivityAt) === null : v.observedActivityAt !== null)
        || typeof v.proofDigest !== 'string' || !HEX.test(v.proofDigest)) throw new TypeError('Invalid retention resolution.');
    return { outcome: v.outcome, confirmedAt: v.confirmedAt as string,
        observedActivityAt: v.observedActivityAt as string | null, proofDigest: v.proofDigest };
}

function validateGuard(input: unknown): RestoreGuard {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid restore guard.');
    const v = input as Record<string, unknown>;
    if (Object.keys(v).sort().join(',') !== 'database,epoch,expiresAt,serverUuid,state'
        || (v.state !== 'active' && v.state !== 'hold') || typeof v.database !== 'string'
        || !/^[A-Za-z0-9_]{1,64}$/u.test(v.database) || !isAccountId(v.serverUuid) || !isAccountId(v.epoch)
        || typeof v.expiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v.expiresAt)
        || !Number.isFinite(Date.parse(v.expiresAt)) || new Date(v.expiresAt).toISOString() !== v.expiresAt) {
        throw new TypeError('Invalid restore guard.');
    }
    return { state: v.state, database: v.database, serverUuid: v.serverUuid, epoch: v.epoch, expiresAt: v.expiresAt };
}

function validateIntent(input: unknown): RetentionIntent {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid retention intent.');
    const v = input as Record<string, unknown>;
    if (Object.keys(v).sort().join(',') !== 'activityAt,channel,childId,deliveredAt,noticeDigest,parentId,receiptDigest,targetDigest,warningId'
        || !isAccountId(v.parentId) || !isAccountId(v.childId) || v.parentId === v.childId || !isAccountId(v.warningId)
        || parseInactivityInstant(v.activityAt) === null || parseInactivityInstant(v.deliveredAt) === null
        || (v.channel !== 'in-app' && v.channel !== 'email')
        || typeof v.targetDigest !== 'string' || !HEX.test(v.targetDigest)
        || typeof v.noticeDigest !== 'string' || !HEX.test(v.noticeDigest)
        || typeof v.receiptDigest !== 'string' || !HEX.test(v.receiptDigest)) throw new TypeError('Invalid retention intent.');
    return { parentId: v.parentId, childId: v.childId, activityAt: v.activityAt as string, warningId: v.warningId,
        targetDigest: v.targetDigest, channel: v.channel, noticeDigest: v.noticeDigest,
        deliveredAt: v.deliveredAt as string, receiptDigest: v.receiptDigest };
}

function authenticatedClient(): JournalHttpClient {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.read_write'] });
    return { async request(options) {
        const client = await auth.getClient(); const headers = await client.getRequestHeaders(options.url);
        options.signal.throwIfAborted();
        for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
        const result = await client.transporter.request({ ...options, headers });
        return { status: result.status, data: result.data };
    } };
}
