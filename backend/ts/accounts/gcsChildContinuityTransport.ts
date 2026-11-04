import { GoogleAuth } from 'google-auth-library';
import type { AppendOnlyObjectTransport } from './childContinuityAppendOnly';
import { DELETION_JOURNAL_BUCKET, type JournalHttpClient, type JournalHttpRequest } from './gcsDeletionJournal';

const API = 'https://storage.googleapis.com';
const FIELDS = 'kind,nextPageToken,items(bucket,name,generation,size,md5Hash,timeDeleted,softDeleteTime)';
const OBJECT_FIELDS = 'bucket,name,generation,size,md5Hash,timeDeleted,softDeleteTime';
const PREFIX = /^v1\/events\/[a-f0-9]{64}\/$/u;
const EVENT = /^v1\/events\/[a-f0-9]{64}\/[0-9]{12}\.json$/u;
const GENERATION = /^[1-9][0-9]{0,19}$/u;

/** Fixed-resource transport. This does not authorize deletion or prove administrative immutability. */
export function createGcsChildContinuityTransport(options: Readonly<{
    bucket: string; expectedBucket: string; client?: JournalHttpClient; timeoutMs?: number;
}>): AppendOnlyObjectTransport & { verifyConfiguration(projectNumber: string): Promise<void> } {
    const { bucket, expectedBucket } = options;
    const timeout = options.timeoutMs ?? 10_000;
    if (typeof bucket !== 'string' || bucket !== expectedBucket || bucket === DELETION_JOURNAL_BUCKET
        || bucket.length < 3 || bucket.length > 63 || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(bucket)
        || bucket.includes('..') || /^\d+\.\d+\.\d+\.\d+$/u.test(bucket)
        || !Number.isInteger(timeout) || timeout < 1 || timeout > 10_000) {
        throw new TypeError('Invalid child continuity transport configuration.');
    }
    const client = options.client ?? authenticatedClient();
    const objectPath = `/storage/v1/b/${bucket}/o`;
    async function request(input: Pick<JournalHttpRequest, 'url' | 'method' | 'params' | 'responseType'>
        & Partial<Pick<JournalHttpRequest, 'headers' | 'data'>>, signal: AbortSignal): Promise<unknown> {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let rejectAbort: (() => void) | undefined;
        try {
            signal.throwIfAborted();
            const deadline = new Promise<never>((_, reject) => {
                rejectAbort = () => reject(new Error('Child continuity storage unavailable.'));
                controller.signal.addEventListener('abort', rejectAbort, { once: true });
                timer = setTimeout(abort, timeout);
            });
            const response = await Promise.race([client.request({ ...input, retry: false, timeout,
                maxRedirects: 0, maxContentLength: 16 * 1024, signal: controller.signal }), deadline]);
            signal.throwIfAborted();
            controller.signal.throwIfAborted();
            if (response.status !== 200) throw new Error('Unexpected status');
            return response.data;
        } catch {
            // Provider exceptions can include bearer tokens, object names, or request data.
            throw new Error('Child continuity storage unavailable.');
        } finally {
            signal.removeEventListener('abort', abort);
            if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
            if (timer !== undefined) clearTimeout(timer);
        }
    }
    function sameBucket(value: string): void {
        if (value !== bucket) throw new TypeError('Invalid child continuity bucket.');
    }
    return Object.freeze({
        async verifyConfiguration(projectNumber) {
            if (!/^[1-9][0-9]{5,19}$/u.test(projectNumber)) throw new TypeError('Invalid continuity project pin.');
            const signal = new AbortController().signal;
            const data = await request({ method: 'GET', url: `${API}/storage/v1/b/${bucket}`, responseType: 'json',
                params: { fields: 'name,projectNumber,metageneration,iamConfiguration,versioning,softDeletePolicy,lifecycle,hierarchicalNamespace' },
                headers: { 'Cache-Control': 'no-cache, no-store' } }, signal);
            const value = data as { name?: unknown; projectNumber?: unknown; metageneration?: unknown;
                iamConfiguration?: { uniformBucketLevelAccess?: { enabled?: unknown }; publicAccessPrevention?: unknown };
                versioning?: { enabled?: unknown }; softDeletePolicy?: { retentionDurationSeconds?: unknown };
                lifecycle?: { rule?: unknown }; hierarchicalNamespace?: { enabled?: unknown } } | null;
            if (!value || value.name !== bucket || value.projectNumber !== projectNumber
                || typeof value.metageneration !== 'string' || !GENERATION.test(value.metageneration)
                || value.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true
                || value.iamConfiguration.publicAccessPrevention !== 'enforced' || value.versioning?.enabled !== true
                || value.softDeletePolicy?.retentionDurationSeconds !== '604800'
                || (value.lifecycle?.rule !== undefined && (!Array.isArray(value.lifecycle.rule) || value.lifecycle.rule.length !== 0))
                || value.hierarchicalNamespace?.enabled === true) throw new Error('Child continuity bucket configuration differs.');
            const required = ['storage.buckets.get', 'storage.objects.create', 'storage.objects.get', 'storage.objects.list'];
            const forbidden = ['storage.buckets.update', 'storage.buckets.delete', 'storage.buckets.setIamPolicy', 'storage.buckets.restore',
                'storage.objects.delete', 'storage.objects.move', 'storage.objects.update', 'storage.objects.setIamPolicy',
                'storage.objects.restore', 'storage.objects.setRetention', 'storage.objects.overrideUnlockedRetention',
                'storage.folders.rename', 'storage.managedFolders.setIamPolicy'];
            const query = [...required, ...forbidden].map(permission => `permissions=${encodeURIComponent(permission)}`).join('&');
            const permissions = await request({ method: 'GET', url: `${API}/storage/v1/b/${bucket}/iam/testPermissions?${query}`,
                responseType: 'json', params: {}, headers: { 'Cache-Control': 'no-cache, no-store' } }, signal) as { kind?: unknown; permissions?: unknown } | null;
            const granted = permissions?.permissions;
            if (!permissions || permissions.kind !== 'storage#testIamPermissionsResponse' || !Array.isArray(granted)
                || granted.length !== required.length || new Set(granted).size !== required.length
                || required.some(permission => !granted.includes(permission))) {
                throw new Error('Child continuity runtime permissions differ.');
            }
            // Detect bucket changes while the identity check was in progress.
            const unchanged = await request({ method: 'GET', url: `${API}/storage/v1/b/${bucket}`, responseType: 'json',
                params: { fields: 'name,metageneration', ifMetagenerationMatch: value.metageneration },
                headers: { 'Cache-Control': 'no-cache, no-store' } }, signal) as { name?: unknown; metageneration?: unknown } | null;
            if (!unchanged || unchanged.name !== bucket || unchanged.metageneration !== value.metageneration) {
                throw new Error('Child continuity bucket changed during verification.');
            }
        },
        async list(input) {
            sameBucket(input.bucket);
            if (!PREFIX.test(input.prefix) || (input.startOffset !== input.prefix
                && (!EVENT.test(input.startOffset) || !input.startOffset.startsWith(input.prefix)))
                || input.maxResults !== 2 || input.fields !== FIELDS
                || !((input.versions === true && input.softDeleted === undefined)
                    || (input.versions === undefined && input.softDeleted === true))) throw new TypeError('Invalid child continuity inventory.');
            const data = await request({ method: 'GET', url: `${API}${objectPath}`, responseType: 'json',
                params: { prefix: input.prefix, startOffset: input.startOffset, maxResults: 2, fields: FIELDS,
                    ...(input.versions ? { versions: true } : { softDeleted: true }) },
                headers: { 'Cache-Control': 'no-cache, no-store' } }, input.signal);
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Child continuity storage unavailable.');
            return data as Awaited<ReturnType<AppendOnlyObjectTransport['list']>>;
        },
        async readBody(input) {
            sameBucket(input.bucket);
            if (!EVENT.test(input.name) || !GENERATION.test(input.generation)
                || input.generation !== input.ifGenerationMatch) throw new TypeError('Invalid child continuity read.');
            const data = await request({ method: 'GET', url: `${API}${objectPath}/${encodeURIComponent(input.name)}`,
                responseType: 'text', params: { alt: 'media', generation: input.generation, ifGenerationMatch: input.generation },
                headers: { 'Cache-Control': 'no-cache, no-store' } }, input.signal);
            if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > 1500) throw new Error('Child continuity storage unavailable.');
            return data;
        },
        async createOnly(input) {
            sameBucket(input.bucket);
            if (!EVENT.test(input.name) || input.ifGenerationMatch !== '0' || typeof input.body !== 'string'
                || Buffer.byteLength(input.body, 'utf8') < 1 || Buffer.byteLength(input.body, 'utf8') > 1500) {
                throw new TypeError('Invalid child continuity write.');
            }
            const data = await request({ method: 'POST', url: `${API}/upload${objectPath}`, responseType: 'json',
                params: { uploadType: 'media', name: input.name, ifGenerationMatch: '0', fields: OBJECT_FIELDS },
                headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache, no-store' },
                data: input.body }, input.signal);
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Child continuity storage unavailable.');
            return data as Awaited<ReturnType<AppendOnlyObjectTransport['createOnly']>>;
        },
    });
}

function authenticatedClient(): JournalHttpClient {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.read_write'] });
    return { async request(options) {
        const client = await auth.getClient();
        const headers = await client.getRequestHeaders(options.url);
        options.signal.throwIfAborted();
        for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
        // Avoid AuthClient's automatic retry after an authentication failure.
        const response = await client.transporter.request({ ...options, headers });
        return { status: response.status, data: response.data };
    } };
}
