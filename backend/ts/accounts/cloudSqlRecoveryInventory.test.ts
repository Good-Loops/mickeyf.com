import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectCloudSqlRecoveryInventory, reconcileCloudSqlBackupListings, RecoveryInventoryUnavailableError, type CloudSqlMetadataClient } from './cloudSqlRecoveryInventory';

const observedAt = '2026-11-05T00:00:00.000000Z';
const backup = (id: string, status: string, enqueuedTime: string, instance = 'cms-mickeyf') =>
    ({ kind: 'sql#backupRun', id, status, enqueuedTime, startTime: enqueuedTime, instance });
const pitr = { kind: 'sql#getLatestRecoveryTime', earliestRecoveryTime: '2026-10-29T12:00:00.123456789Z',
    latestRecoveryTime: '2026-11-04T12:00:00Z' };
const options = { project: 'noted-reef-387021', instance: 'cms-mickeyf', observedAt };

test('reconciles both project-wide backup APIs and rejects warnings or unlisted backups', async () => {
    const run = backup('1', 'SUCCESSFUL', '2026-11-01T00:00:00Z');
    const item = { kind: 'sql#backup', name: `projects/${options.project}/backups/synthetic`,
        backupRun: `projects/${options.project}/instances/cms-mickeyf/backupRuns/1` };
    const fetchPages = (extra: object = {}) => async (url: string, params: Record<string, string | number>) => {
        if (url.endsWith('/backupRuns')) return { kind: 'sql#backupRunsList', items: [run] };
        return params.pageToken ? { backups: [] } : { backups: [item], ...extra };
    };
    assert.deepEqual(await reconcileCloudSqlBackupListings(options.project, fetchPages()), { kind: 'sql#backupRunsList', items: [run] });
    assert.deepEqual(await reconcileCloudSqlBackupListings(options.project, fetchPages({ nextPageToken: 'second' })),
        { kind: 'sql#backupRunsList', items: [run] });
    for (const extra of [{ warnings: [{ code: 'REGION_UNAVAILABLE' }] }, { backups: [item, { ...item, backupRun: undefined }] },
        { backups: [] }, { nextPageToken: 'repeat' }]) {
        const getter = extra.nextPageToken === 'repeat'
            ? async (url: string) => url.endsWith('/backupRuns') ? { kind: 'sql#backupRunsList', items: [run] }
                : { backups: [], nextPageToken: 'repeat' }
            : fetchPages(extra);
        await assert.rejects(reconcileCloudSqlBackupListings(options.project, getter), RecoveryInventoryUnavailableError);
    }
});

test('scans all pages and takes a conservative floor across all project backups and PITR', async () => {
    const calls: (string | undefined)[] = [];
    const client: CloudSqlMetadataClient = {
        async listBackups(_project, pageToken) {
            calls.push(pageToken);
            return pageToken === undefined
                ? { kind: 'sql#backupRunsList', items: [backup('1', 'SUCCESSFUL', '2026-10-30T00:00:00Z')], nextPageToken: 'next' }
                : { kind: 'sql#backupRunsList', items: [backup('2', 'DELETION_FAILED', '2026-10-28T00:00:00.123456789Z', 'other-instance')] };
        },
        async getRecoveryWindow() { return pitr; },
    };
    assert.deepEqual(await collectCloudSqlRecoveryInventory({ ...options, client }), {
        project: options.project, instance: options.instance, cloudSqlFloor: '2026-10-28T00:00:00.123456Z',
        latestRecoveryAt: '2026-11-04T12:00:00.000000Z', backupCount: 2, observedAt,
    });
    assert.deepEqual(calls, [undefined, 'next', undefined, 'next']);
});

test('uses PITR when it is older and excludes only explicitly non-restorable statuses', async () => {
    const client: CloudSqlMetadataClient = {
        async listBackups() { return { kind: 'sql#backupRunsList', items: [
            backup('1', 'FAILED', '2026-01-01T00:00:00Z'),
            backup('2', 'RUNNING', '2026-11-01T00:00:00Z'),
            backup('3', 'SUCCESSFUL', '2026-11-02T00:00:00Z'),
        ] }; },
        async getRecoveryWindow() { return pitr; },
    };
    assert.equal((await collectCloudSqlRecoveryInventory({ ...options, client })).cloudSqlFloor, '2026-10-29T12:00:00.123456Z');
});

test('uses the earlier PITR boundary when the provider window changes during the scan', async () => {
    let calls = 0;
    const client: CloudSqlMetadataClient = {
        async listBackups() { return { kind: 'sql#backupRunsList', items: [backup('1', 'SUCCESSFUL', '2026-11-01T00:00:00Z')] }; },
        async getRecoveryWindow() { return { ...pitr, earliestRecoveryTime: ++calls === 1
            ? '2026-10-29T12:00:00Z' : '2026-10-28T00:00:00Z' }; },
    };
    assert.equal((await collectCloudSqlRecoveryInventory({ ...options, client })).cloudSqlFloor, '2026-10-28T00:00:00.000000Z');
});

test('fails closed on changed inventories, repeated pages and unknown statuses', async () => {
    let scans = 0;
    const changed: CloudSqlMetadataClient = {
        async listBackups() { return { kind: 'sql#backupRunsList', items: [backup('1', 'SUCCESSFUL',
            ++scans === 1 ? '2026-10-30T00:00:00Z' : '2026-10-29T00:00:00Z')] }; },
        async getRecoveryWindow() { return pitr; },
    };
    const repeated: CloudSqlMetadataClient = {
        async listBackups() { return { kind: 'sql#backupRunsList', nextPageToken: 'repeat' }; },
        async getRecoveryWindow() { return pitr; },
    };
    const unknown: CloudSqlMetadataClient = {
        async listBackups() { return { kind: 'sql#backupRunsList', items: [backup('1', 'NEW_STATUS', '2026-10-30T00:00:00Z')] }; },
        async getRecoveryWindow() { return pitr; },
    };
    for (const client of [changed, repeated, unknown]) {
        await assert.rejects(collectCloudSqlRecoveryInventory({ ...options, client }), RecoveryInventoryUnavailableError);
    }
});

test('fails closed when PITR, backup metadata or provider access is unavailable', async () => {
    const clients: CloudSqlMetadataClient[] = [
        { async listBackups() { throw new Error('private provider detail'); }, async getRecoveryWindow() { return pitr; } },
        { async listBackups() { return { kind: 'sql#backupRunsList', items: [] }; }, async getRecoveryWindow() { return pitr; } },
        { async listBackups() { return { kind: 'sql#backupRunsList', items: [backup('1', 'RUNNING', '2026-10-30T00:00:00Z')] }; }, async getRecoveryWindow() { return pitr; } },
        { async listBackups() { return { kind: 'sql#backupRunsList', items: [backup('1', 'SUCCESSFUL', 'invalid')] }; }, async getRecoveryWindow() { return pitr; } },
        { async listBackups() { return { kind: 'sql#backupRunsList', items: [backup('1', 'SUCCESSFUL', '2026-10-30T00:00:00Z')] }; },
            async getRecoveryWindow() { return { ...pitr, earliestRecoveryTime: undefined }; } },
    ];
    for (const client of clients) {
        await assert.rejects(collectCloudSqlRecoveryInventory({ ...options, client }), error => {
            assert.ok(error instanceof RecoveryInventoryUnavailableError);
            assert.doesNotMatch(String(error), /private provider detail/u);
            return true;
        });
    }
});
