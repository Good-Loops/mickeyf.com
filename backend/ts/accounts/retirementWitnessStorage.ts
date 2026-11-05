import { createHash, createHmac } from 'node:crypto';
import { isAccountId } from './deletionJournal';
import { createContinuityHead, type ContinuityHeadStorage } from './childContinuityHead';
import type { JournalHttpClient } from './gcsDeletionJournal';
import { RETIREMENT_API as API, RETIREMENT_FIELDS as FIELDS, retirementStorageRequest as request,
    retirementObjectMetadata as metadata } from './gcsRetirementTransport';

export type RetirementWitness = Readonly<{ name: string; generation: string; metageneration: string; contentSha256: string }>;

/** Private, bounded witness inventory. Callers must independently authorize every deletion. */
export function createRetirementWitnessStorage(client: JournalHttpClient, bucket: string) {
    if (!client || typeof client.request !== 'function' || typeof bucket !== 'string'
        || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) || bucket.includes('..')) throw new TypeError('Invalid witness storage.');
    const base = `${API}/storage/v1/b/${bucket}/o`;
    function prefix(childId: string, key: Buffer): string {
        if (!isAccountId(childId) || !Buffer.isBuffer(key) || key.length !== 32) throw new Error();
        return `v1/events/${createHmac('sha256', key).update('ludolume-child-head-id-v1\0').update(childId).digest('hex')}/`;
    }
    async function list(childId: string, key: Buffer): Promise<RetirementWitness[]> {
        const root = prefix(childId, key), names = new Set<string>(), tokens = new Set<string>();
        const pending: Array<{ name: string; generation: string; metageneration: string; size: number; md5: string }> = [];
        let pageToken: string | undefined;
        do {
            const response = await request(client, { method: 'GET', url: base, responseType: 'json', params: { prefix: root,
                versions: true, maxResults: 100, fields: `kind,nextPageToken,items(${FIELDS})`, ...(pageToken ? { pageToken } : {}) } });
            if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error();
            const page = response as Record<string, unknown>;
            if (page.kind !== 'storage#objects' || (page.items !== undefined && !Array.isArray(page.items)) || page.prefixes !== undefined) throw new Error();
            const items = (page.items ?? []) as unknown[];
            if (items.length > 100 || pending.length + items.length > 10_000) throw new Error();
            for (const item of items) {
                if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error();
                const value = item as Record<string, unknown>, name = value.name;
                if (typeof name !== 'string' || !name.startsWith(root) || !/^[0-9]{12}\.json$/u.test(name.slice(root.length))
                    || Number(name.slice(root.length, -5)) < 1) throw new Error();
                const parsed = metadata(value, bucket, name, false, 1500, true);
                const identity = `${name}\0${parsed.generation}`;
                if (names.has(identity)) throw new Error();
                names.add(identity); pending.push({ name, ...parsed });
            }
            if (page.nextPageToken === undefined) pageToken = undefined;
            else {
                if (typeof page.nextPageToken !== 'string' || !page.nextPageToken || page.nextPageToken.length > 4096
                    || tokens.has(page.nextPageToken)) throw new Error();
                pageToken = page.nextPageToken; tokens.add(pageToken);
                if (tokens.size > 10_000) throw new Error();
            }
        } while (pageToken);
        const unused: ContinuityHeadStorage = { async read() { throw new Error(); }, async replace() { throw new Error(); } };
        const verifier = createContinuityHead(unused, key, 10_000, 'distinct-objects');
        const result: RetirementWitness[] = [];
        for (const item of pending) {
            const url = `${base}/${encodeURIComponent(item.name)}`;
            const body = await request(client, { method: 'GET', url, params: { alt: 'media', generation: item.generation,
                ifGenerationMatch: item.generation }, responseType: 'text' });
            if (typeof body !== 'string' || Buffer.byteLength(body) !== item.size || createHash('md5').update(body).digest('base64') !== item.md5) throw new Error();
            const verified = verifier.inspectArchivedEvent(childId, item.generation, body);
            if (String(verified.sequence).padStart(12, '0') !== item.name.slice(root.length, -5)) throw new Error();
            result.push({ name: item.name, generation: item.generation, metageneration: item.metageneration, contentSha256: verified.digest });
        }
        return result.sort((a, b) => a.name.localeCompare(b.name) || a.generation.localeCompare(b.generation));
    }
    async function assertEmpty(childId: string, key: Buffer): Promise<void> {
        const root = prefix(childId, key);
        const value = await request(client, { method: 'GET', url: base, responseType: 'json', params: { prefix: root,
            versions: true, maxResults: 1, fields: 'kind,nextPageToken,items(name)' } });
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        const page = value as Record<string, unknown>;
        if (page.kind !== 'storage#objects' || page.nextPageToken !== undefined || page.prefixes !== undefined
            || (page.items !== undefined && (!Array.isArray(page.items) || page.items.length !== 0))) throw new Error();
    }
    /** Complete live/noncurrent inventory; unknown objects are not silently skipped. */
    async function listAllIdentities(): Promise<ReadonlyArray<Readonly<{ name: string; generation: string }>>> {
        const identities = new Set<string>(), tokens = new Set<string>();
        let pageToken: string | undefined;
        do {
            const value = await request(client, { method: 'GET', url: base, responseType: 'json', params: {
                versions: true, maxResults: 1000, fields: 'kind,nextPageToken,items(name,generation)',
                ...(pageToken ? { pageToken } : {}) } });
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
            const page = value as Record<string, unknown>;
            if (page.kind !== 'storage#objects' || page.prefixes !== undefined
                || (page.items !== undefined && !Array.isArray(page.items))) throw new Error();
            const items = (page.items ?? []) as unknown[];
            if (items.length > 1000 || identities.size + items.length > 100_000) throw new Error();
            for (const value of items) {
                if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
                const item = value as Record<string, unknown>;
                if (typeof item.name !== 'string' || !/^v1\/events\/[a-f0-9]{64}\/[0-9]{12}\.json$/u.test(item.name)
                    || typeof item.generation !== 'string' || !/^[1-9][0-9]*$/u.test(item.generation)) throw new Error();
                const identity = JSON.stringify([item.name, item.generation]);
                if (identities.has(identity)) throw new Error();
                identities.add(identity);
            }
            if (page.nextPageToken === undefined) pageToken = undefined;
            else {
                if (typeof page.nextPageToken !== 'string' || !page.nextPageToken || page.nextPageToken.length > 4096
                    || tokens.has(page.nextPageToken) || tokens.size >= 1000) throw new Error();
                pageToken = page.nextPageToken; tokens.add(pageToken);
            }
        } while (pageToken);
        return [...identities].sort().map(value => {
            const [name, generation] = JSON.parse(value) as [string, string]; return { name, generation };
        });
    }
    async function remove(entry: RetirementWitness): Promise<void> {
        const url = `${base}/${encodeURIComponent(entry.name)}`;
        await request(client, { method: 'DELETE', url, params: { generation: entry.generation,
            ifGenerationMatch: entry.generation, ifMetagenerationMatch: entry.metageneration }, responseType: 'json' });
        const deleted = metadata(await request(client, { method: 'GET', url, params: { generation: entry.generation,
            softDeleted: true, fields: FIELDS }, responseType: 'json' }), bucket, entry.name, true, 1500);
        if (deleted.generation !== entry.generation) throw new Error();
    }
    return { list, assertEmpty, listAllIdentities, remove };
}
