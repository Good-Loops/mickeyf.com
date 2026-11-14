import { GoogleAuth } from 'google-auth-library';
import type { JournalHttpClient, JournalHttpRequest } from './gcsDeletionJournal';

export const RETIREMENT_API = 'https://storage.googleapis.com';
export const RETIREMENT_FIELDS = 'bucket,name,generation,metageneration,size,md5Hash,timeDeleted,softDeleteTime,metadata';
export type RetirementObjectMetadata = Readonly<{ generation: string; metageneration: string; size: number; md5: string;
    metadata: Record<string, string>; softDeleteTime?: string }>;

function object(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    return input as Record<string, unknown>;
}

export function retirementObjectMetadata(input: unknown, bucket: string, name: string, softDeleted: boolean,
    maxBytes: number, allowNoncurrent = false): RetirementObjectMetadata {
    const value = object(input), custom = value.metadata === undefined ? {} : object(value.metadata);
    if (value.bucket !== bucket || value.name !== name || typeof value.generation !== 'string' || !/^[1-9][0-9]*$/u.test(value.generation)
        || typeof value.metageneration !== 'string' || !/^[1-9][0-9]*$/u.test(value.metageneration)
        || typeof value.size !== 'string' || !/^[1-9][0-9]*$/u.test(value.size) || Number(value.size) > maxBytes
        || typeof value.md5Hash !== 'string' || !/^[A-Za-z0-9+/]{22}==$/u.test(value.md5Hash)
        || (softDeleted ? typeof value.softDeleteTime !== 'string' || !Number.isFinite(Date.parse(value.softDeleteTime))
            : value.softDeleteTime !== undefined || (value.timeDeleted !== undefined
                && (!allowNoncurrent || typeof value.timeDeleted !== 'string' || !Number.isFinite(Date.parse(value.timeDeleted)))))
        || Object.values(custom).some(item => typeof item !== 'string')) throw new Error();
    return { generation: value.generation, metageneration: value.metageneration, size: Number(value.size), md5: value.md5Hash,
        metadata: custom as Record<string, string>, ...(softDeleted ? { softDeleteTime: value.softDeleteTime as string } : {}) };
}

export async function retirementStorageRequest(client: JournalHttpClient, input: Pick<JournalHttpRequest, 'url' | 'method' | 'params' | 'responseType'>
    & Partial<Pick<JournalHttpRequest, 'headers' | 'data'>>, allowMissing = false): Promise<unknown> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error()); }, 10_000); });
        const response = await Promise.race([client.request({ ...input, retry: false, timeout: 10_000,
            maxContentLength: 256 * 1024, maxRedirects: 0, signal: controller.signal }), deadline]);
        if (allowMissing && response.status === 404) return null;
        if (response.status !== (input.method === 'DELETE' ? 204 : 200)) throw new Error();
        return response.data;
    } catch (error) {
        if (allowMissing && (error as { response?: { status?: number } })?.response?.status === 404) return null;
        throw error;
    } finally { if (timer !== undefined) clearTimeout(timer); }
}

export async function verifyRetirementBucketPolicy(client: JournalHttpClient, bucket: string): Promise<void> {
    const value = object(await retirementStorageRequest(client, { method: 'GET', url: `${RETIREMENT_API}/storage/v1/b/${bucket}`, params: {
        fields: 'name,versioning(enabled),softDeletePolicy(retentionDurationSeconds,hardDeletePause(enabled))' }, responseType: 'json' }));
    const versioning = object(value.versioning), policy = object(value.softDeletePolicy);
    const pause = policy.hardDeletePause === undefined ? {} : object(policy.hardDeletePause);
    if (value.name !== bucket || versioning.enabled !== true || String(policy.retentionDurationSeconds) !== '604800'
        || pause.enabled === true) throw new Error();
}

export function createRetirementStorageClient(): JournalHttpClient {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.full_control'] });
    return { async request(options) {
        const client = await auth.getClient(), headers = { ...await client.getRequestHeaders(options.url), ...options.headers };
        options.signal.throwIfAborted();
        return client.transporter.request({ ...options, headers });
    } };
}
