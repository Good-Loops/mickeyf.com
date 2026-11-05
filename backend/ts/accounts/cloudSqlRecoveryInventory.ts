import { GoogleAuth } from 'google-auth-library';

/**
 * Read-only Cloud SQL inventory. This covers the listed Cloud SQL project and
 * PITR window only; it does not authenticate other exports or authorize cleanup.
 */
export type CloudSqlMetadataClient = Readonly<{
    listBackups(project: string, pageToken?: string): Promise<unknown>;
    getRecoveryWindow(project: string, instance: string): Promise<unknown>;
}>;

export class RecoveryInventoryUnavailableError extends Error {
    constructor() { super('Cloud SQL recovery inventory is incomplete or unavailable.'); }
}

const RETAINED = new Set(['SUCCESSFUL', 'DELETION_PENDING', 'DELETION_FAILED', 'RUNNING', 'ENQUEUED', 'OVERDUE']);
const NOT_RESTORABLE = new Set(['FAILED', 'SKIPPED', 'DELETED']);
const LIMIT = 10_000;

/** Refuse cleanup if the project-wide backup APIs disagree or return warnings. */
export async function reconcileCloudSqlBackupListings(project: string, get: (url: string, params: Record<string, string | number>) => Promise<unknown>): Promise<unknown> {
    const base = `https://sqladmin.googleapis.com/sql/v1beta4/projects/${encodeURIComponent(project)}`;
    async function pages(url: string, fields: string, pageSize: string, size: number, itemField: string): Promise<Record<string, unknown>[]> {
        const items: Record<string, unknown>[] = [], tokens = new Set<string>();
        let token: string | undefined;
        do {
            const page = record(await get(url, { [pageSize]: size, fields, ...(token ? { pageToken: token } : {}) }));
            if (itemField === 'items' && page.kind !== 'sql#backupRunsList') throw new Error();
            if (page.warnings !== undefined && (!Array.isArray(page.warnings) || page.warnings.length)) throw new Error();
            if (page[itemField] !== undefined && !Array.isArray(page[itemField])) throw new Error();
            for (const item of (page[itemField] ?? []) as unknown[]) {
                if (items.length >= LIMIT) throw new Error();
                items.push(record(item));
            }
            if (page.nextPageToken === undefined) token = undefined;
            else {
                if (typeof page.nextPageToken !== 'string' || !page.nextPageToken || page.nextPageToken.length > 4096
                    || tokens.has(page.nextPageToken)) throw new Error();
                token = page.nextPageToken; tokens.add(token);
                if (tokens.size > LIMIT) throw new Error();
            }
        } while (token !== undefined);
        return items;
    }
    try {
        if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project)) throw new Error();
        const runs = await pages(`${base}/instances/-/backupRuns`, 'kind,nextPageToken,items(kind,id,instance,status,enqueuedTime,startTime)', 'maxResults', 100, 'items');
        const backups = await pages(`${base}/backups`, 'nextPageToken,warnings,backups(kind,name,backupRun)', 'pageSize', 100, 'backups');
        const runNames = runs.map(run => {
            if (run.kind !== 'sql#backupRun' || typeof run.instance !== 'string' || !/^[a-z][a-z0-9-]{0,96}[a-z0-9]$/u.test(run.instance)
                || typeof run.id !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(run.id)) throw new Error();
            return `projects/${project}/instances/${run.instance}/backupRuns/${run.id}`;
        });
        const backupRuns = backups.map(backup => {
            if (backup.kind !== 'sql#backup' || typeof backup.name !== 'string' || !backup.name.startsWith(`projects/${project}/backups/`)
                || typeof backup.backupRun !== 'string') throw new Error();
            return backup.backupRun;
        });
        if (new Set(runNames).size !== runNames.length || new Set(backupRuns).size !== backupRuns.length
            || JSON.stringify(runNames.sort()) !== JSON.stringify(backupRuns.sort())) throw new Error();
        return { kind: 'sql#backupRunsList', items: runs };
    } catch { throw new RecoveryInventoryUnavailableError(); }
}

/** Authenticated, read-only requests. Never log provider errors or credentials. */
export function createCloudSqlMetadataClient(): CloudSqlMetadataClient {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloudsql'] });
    async function get(url: string, params: Record<string, string | number>): Promise<unknown> {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new RecoveryInventoryUnavailableError()); }, 10_000);
            });
            const request = (async () => {
                const client = await auth.getClient();
                controller.signal.throwIfAborted();
                const result = await client.request({ url, method: 'GET', params, responseType: 'json',
                    timeout: 10_000, signal: controller.signal, retry: false, maxRedirects: 0, maxContentLength: 256 * 1024 });
                if (result.status !== 200) throw new Error();
                return result.data;
            })();
            return await Promise.race([request, timeout]);
        } catch { throw new RecoveryInventoryUnavailableError(); }
        finally { if (timer !== undefined) clearTimeout(timer); }
    }
    return {
        listBackups(project, pageToken) {
            if (pageToken !== undefined) throw new RecoveryInventoryUnavailableError();
            return reconcileCloudSqlBackupListings(project, get);
        },
        getRecoveryWindow(project, instance) {
            return get(`https://sqladmin.googleapis.com/sql/v1beta4/projects/${encodeURIComponent(project)}/instances/${encodeURIComponent(instance)}/getLatestRecoveryTime`,
                { fields: 'kind,earliestRecoveryTime,latestRecoveryTime' });
        },
    };
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RecoveryInventoryUnavailableError();
    return value as Record<string, unknown>;
}

/** Round down to microseconds, so a sub-microsecond boundary never moves forward. */
function conservativeInstant(value: unknown): string {
    if (typeof value !== 'string') throw new RecoveryInventoryUnavailableError();
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/u.exec(value);
    if (!match) throw new RecoveryInventoryUnavailableError();
    const fraction = (match[2] ?? '').padEnd(9, '0');
    const milliseconds = `${match[1]}.${fraction.slice(0, 3)}Z`;
    const parsed = Date.parse(milliseconds);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== milliseconds) throw new RecoveryInventoryUnavailableError();
    return `${match[1]}.${fraction.slice(0, 6)}Z`;
}

/** Poll only the PITR window while waiting; full backup enumeration remains a separate check. */
export async function readCloudSqlRecoveryWindow(options: Readonly<{ project: string; instance: string;
    observedAt: string; client: CloudSqlMetadataClient }>): Promise<Readonly<{ earliest: string; latest: string }>> {
    try {
        if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(options.project)
            || !/^[a-z][a-z0-9-]{0,96}[a-z0-9]$/u.test(options.instance)
            || typeof options.client?.getRecoveryWindow !== 'function') throw new Error();
        const observedAt = conservativeInstant(options.observedAt);
        const window = record(await options.client.getRecoveryWindow(options.project, options.instance));
        if (window.kind !== 'sql#getLatestRecoveryTime') throw new Error();
        const earliest = conservativeInstant(window.earliestRecoveryTime), latest = conservativeInstant(window.latestRecoveryTime);
        if (earliest > latest || latest > observedAt) throw new Error();
        return { earliest, latest };
    } catch { throw new RecoveryInventoryUnavailableError(); }
}

/**
 * Enumerates every project backup page, including in-progress and failed
 * deletions, and the target instance's PITR window. A second matching scan
 * detects inventory changes during the read. Callers must independently cover
 * exports, other projects/services, restore provenance and writer fencing.
 */
export async function collectCloudSqlRecoveryInventory(options: Readonly<{
    project: string; instance: string; observedAt: string; client: CloudSqlMetadataClient;
}>): Promise<Readonly<{ project: string; instance: string; cloudSqlFloor: string;
    latestRecoveryAt: string; backupCount: number; observedAt: string }>> {
    try {
        const { project, instance, client } = options;
        if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project)
            || !/^[a-z][a-z0-9-]{0,96}[a-z0-9]$/u.test(instance)
            || typeof client?.listBackups !== 'function' || typeof client?.getRecoveryWindow !== 'function') throw new Error();
        const observedAt = conservativeInstant(options.observedAt);
        async function scan() {
            const entries: string[] = [];
            const seen = new Set<string>();
            const tokens = new Set<string>();
            let successfulSourceBackups = 0;
            let token: string | undefined;
            do {
                const page = record(await client.listBackups(project, token));
                if (page.kind !== 'sql#backupRunsList' || (page.items !== undefined && !Array.isArray(page.items))) throw new Error();
                for (const raw of (page.items ?? []) as unknown[]) {
                    if (seen.size >= LIMIT) throw new Error();
                    const backup = record(raw);
                    if (backup.kind !== 'sql#backupRun' || typeof backup.instance !== 'string'
                        || !/^[a-z][a-z0-9-]{0,96}[a-z0-9]$/u.test(backup.instance)
                        || typeof backup.id !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(backup.id)
                        || typeof backup.status !== 'string') throw new Error();
                    const id = `${backup.instance}/${backup.id}`;
                    if (seen.has(id)) throw new Error();
                    seen.add(id);
                    if (NOT_RESTORABLE.has(backup.status)) continue;
                    if (!RETAINED.has(backup.status)) throw new Error();
                    if (backup.status === 'SUCCESSFUL' && backup.startTime === undefined) throw new Error();
                    const times = [backup.enqueuedTime, backup.startTime]
                        .filter(value => value !== undefined).map(conservativeInstant).sort();
                    if (times.length === 0) throw new Error();
                    const time = times[0];
                    if (times.some(value => value > observedAt)) throw new Error();
                    entries.push(`${id}\0${backup.status}\0${time}`);
                    if (backup.instance === instance && backup.status === 'SUCCESSFUL') successfulSourceBackups++;
                }
                if (page.nextPageToken === undefined) token = undefined;
                else {
                    if (typeof page.nextPageToken !== 'string' || !page.nextPageToken
                        || page.nextPageToken.length > 4096 || tokens.has(page.nextPageToken)) throw new Error();
                    token = page.nextPageToken;
                    tokens.add(token);
                    if (tokens.size > LIMIT) throw new Error();
                }
            } while (token !== undefined);
            if (successfulSourceBackups === 0) throw new Error();
            return entries.sort();
        }
        const before = await scan();
        const firstWindow = await readCloudSqlRecoveryWindow({ project, instance, observedAt, client });
        const after = await scan();
        const secondWindow = await readCloudSqlRecoveryWindow({ project, instance, observedAt, client });
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error();
        const times = before.map(entry => entry.slice(entry.lastIndexOf('\0') + 1));
        return Object.freeze({ project, instance, cloudSqlFloor: [...times, firstWindow.earliest, secondWindow.earliest].sort()[0],
            latestRecoveryAt: [firstWindow.latest, secondWindow.latest].sort()[0], backupCount: before.length, observedAt });
    } catch { throw new RecoveryInventoryUnavailableError(); }
}
