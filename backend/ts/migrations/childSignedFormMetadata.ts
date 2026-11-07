import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MigrationConnection } from './leaderboardSchema';
import { verifyHistoryTable } from './leaderboardSchema';
import { loadMigrationManifest } from './migrationManifest';
import { verifySignedParentFormSchema } from './signedParentFormSchema';
import { createRuntimeGrantPlan, inspectRuntimeGrantState, type RuntimeGrantConnection,
    type RuntimeGrantSnapshot } from '../security/runtimeGrantOperations';
import { PRODUCTION_RUNTIME_DATABASE_ACCOUNT, PRODUCTION_RUNTIME_DATABASE_ROLE } from '../security/runtimeGrantManifest';

export type ChildSignedFormTarget = Readonly<{ project: string; instance: string; database: string; serverUuid: string }>;
export type ChildSignedFormMetadataSettings = Readonly<{
    target: ChildSignedFormTarget;
    expectedCurrentUser: string;
    expectedServerVersion: string;
    expectedVersionComment: string;
}>;
export type ChildSignedFormIdentity = Readonly<{ databaseName: string; currentUser: string; serverUuid: string;
    serverVersion: string; versionComment: string }>;
type MetadataValue = string | number | boolean | null | readonly MetadataValue[] | { readonly [name: string]: MetadataValue };
type SchemaInspection = Readonly<{ query: string; parameters: readonly MetadataValue[]; rows: MetadataValue }>;
export type ChildSignedFormMetadataSnapshot = Readonly<{
    observedAt: string;
    target: ChildSignedFormTarget;
    identity: ChildSignedFormIdentity;
    history: readonly Readonly<{ version: string; checksumSha256: string }>[];
    capability: 'legacy-us' | 'nullable-parent-request-us-br';
    schema: readonly SchemaInspection[];
    grants: Readonly<Omit<RuntimeGrantSnapshot, 'passwordExpired'> & { credentialExpiryState: 'current' | 'expired' }>;
    schemaSha256: string;
    grantsSha256: string;
}>;
export type ChildSignedFormSource = Readonly<{ sourceCommit: string; sqlSha256: string }>;
export type ChildSignedFormSchemaReceipt = Readonly<{
    schemaVersion: 1;
    operation: 'verify-child-signed-form-schema';
    verifiedAt: string;
    sourceCommit: string;
    sqlSha256: string;
    target: ChildSignedFormTarget;
    capability: 'nullable-parent-request-us-br';
    runtimeGrantProfile: 'google-apple-parent-signed';
    schemaSha256: string;
    grantsSha256: string;
}>;

const observed = new WeakSet<object>();
const fail = () => { throw new Error('Child signed-form metadata does not match the explicitly reviewed target, history, schema or runtime grants.'); };
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function normalize(value: unknown): MetadataValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) {
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, normalize(item)]));
    }
    return fail();
}
function freeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) freeze(item);
        Object.freeze(value);
    }
    return value;
}

function validateSettings(settings: ChildSignedFormMetadataSettings) {
    const target = settings?.target;
    const separator = settings?.expectedCurrentUser?.lastIndexOf('@') ?? -1;
    if (!target || !/^[a-z][a-z0-9-]{4,62}$/u.test(target.project) || !/^[a-z][a-z0-9-]{0,97}$/u.test(target.instance)
        || !/^[A-Za-z0-9_]{1,64}$/u.test(target.database) || !uuid.test(target.serverUuid)
        || separator < 1 || separator === settings.expectedCurrentUser.length - 1
        || settings.expectedCurrentUser.length > 288 || /[\u0000-\u0020\u007f'`]/u.test(settings.expectedCurrentUser)
        || !/^8\.0\.31(?:[-.]|$)/u.test(settings.expectedServerVersion)
        || !settings.expectedVersionComment || settings.expectedVersionComment.length > 255) fail();
    return { user: settings.expectedCurrentUser.slice(0, separator), host: settings.expectedCurrentUser.slice(separator + 1) };
}

async function identity(connection: MigrationConnection, settings: ChildSignedFormMetadataSettings): Promise<ChildSignedFormIdentity> {
    const [rows] = await connection.query(`SELECT DATABASE() AS databaseName, CURRENT_USER() AS currentUser,
        @@GLOBAL.server_uuid AS serverUuid, @@version AS serverVersion, @@version_comment AS versionComment`);
    if (!Array.isArray(rows) || rows.length !== 1) return fail();
    const row = rows[0];
    if (row.databaseName !== settings.target.database || row.currentUser !== settings.expectedCurrentUser
        || row.serverUuid !== settings.target.serverUuid || row.serverVersion !== settings.expectedServerVersion
        || row.versionComment !== settings.expectedVersionComment) return fail();
    return { databaseName: row.databaseName, currentUser: row.currentUser, serverUuid: row.serverUuid,
        serverVersion: row.serverVersion, versionComment: row.versionComment };
}

async function history(connection: MigrationConnection) {
    const manifest = loadMigrationManifest();
    if (manifest.length !== 26 || manifest.some((migration, index) => migration.version.slice(0, 4) !== String(index + 1).padStart(4, '0'))) return fail();
    const [rows] = await connection.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
    if (!Array.isArray(rows) || rows.length !== manifest.length) return fail();
    return manifest.map((migration, index) => {
        const row = rows[index];
        if (row.version !== migration.version || !Buffer.isBuffer(row.checksum) || !row.checksum.equals(migration.checksum)) return fail();
        return { version: migration.version, checksumSha256: migration.checksum.toString('hex') };
    });
}

async function inspect(connection: MigrationConnection, settings: ChildSignedFormMetadataSettings) {
    const maintenanceAccount = validateSettings(settings);
    const observedIdentity = await identity(connection, settings);
    const schema: SchemaInspection[] = [];
    let nullable: string | undefined;
    const schemaConnection: MigrationConnection = { async query(sql, parameters = []) {
        const result = await connection.query(sql, parameters);
        if (sql.includes('SELECT IS_NULLABLE AS nullable') && Array.isArray(result[0]) && result[0].length === 1) nullable = result[0][0].nullable;
        schema.push({ query: sql.replace(/\s+/gu, ' ').trim(), parameters: parameters.map(normalize), rows: normalize(result[0]) });
        return result;
    } };
    await verifyHistoryTable(schemaConnection);
    const observedHistory = await history(connection);
    await verifySignedParentFormSchema(schemaConnection);
    if (nullable !== 'YES' && nullable !== 'NO') return fail();
    // Inspect and classify directly: the ordinary verify helper also takes locks and SETs session options.
    const grantConnection: RuntimeGrantConnection = { query: (sql, values) => connection.query(sql, values ? [...values] : []), destroy() {} };
    const grantMetadata = await inspectRuntimeGrantState(grantConnection, settings.target.database, PRODUCTION_RUNTIME_DATABASE_ACCOUNT);
    const plan = createRuntimeGrantPlan(grantMetadata, { profile: 'google-apple-parent-signed', database: settings.target.database,
        expectedServerUuid: settings.target.serverUuid, maintenanceAccount, approvedRole: PRODUCTION_RUNTIME_DATABASE_ROLE,
        roleRemovalProvider: 'read-only-child-schema-observer', roleRemovalTarget: 'none', advisoryLockTimeoutSeconds: 0,
        lockWaitTimeoutSeconds: 1 }, PRODUCTION_RUNTIME_DATABASE_ACCOUNT);
    if (!plan.compliant || plan.state !== 'reduced' || plan.blockers.length !== 0
        || grantMetadata.serverVersion !== settings.expectedServerVersion || grantMetadata.versionComment !== settings.expectedVersionComment) return fail();
    const { passwordExpired: expired, ...metadata } = grantMetadata;
    const grants = { ...metadata, credentialExpiryState: expired ? 'expired' as const : 'current' as const };
    const capability = nullable === 'YES' ? 'nullable-parent-request-us-br' as const : 'legacy-us' as const;
    if (JSON.stringify(await identity(connection, settings)) !== JSON.stringify(observedIdentity)) return fail();
    return { target: { ...settings.target }, identity: observedIdentity, history: observedHistory, capability,
        schema: normalize(schema) as unknown as readonly SchemaInspection[], grants,
        schemaSha256: sha256({ history: observedHistory, capability, schema }), grantsSha256: plan.sha256 };
}

/** SQL metadata alone cannot establish the GCP project/instance; the authenticated outer gate must bind those pins. */
export async function observeChildSignedFormMetadata(connection: MigrationConnection,
    settings: ChildSignedFormMetadataSettings): Promise<ChildSignedFormMetadataSnapshot> {
    const first = await inspect(connection, settings);
    const second = await inspect(connection, settings);
    if (JSON.stringify(first) !== JSON.stringify(second)) return fail();
    const snapshot = freeze({ ...second, observedAt: new Date().toISOString() });
    observed.add(snapshot);
    return snapshot;
}

/** The CLI separately proves sourceCommit is the actual approved clean HEAD; JSON alone is not source evidence. */
export function createChildSignedFormSchemaReceipt(snapshot: ChildSignedFormMetadataSnapshot,
    source: ChildSignedFormSource, verifiedAt = snapshot.observedAt): ChildSignedFormSchemaReceipt {
    const actualSqlSha256 = createHash('sha256').update(readFileSync(path.resolve(__dirname,
        '../../migrations/pending/0028_extend_child_signed_parent_forms.sql'))).digest('hex');
    if (!observed.has(snapshot) || snapshot.capability !== 'nullable-parent-request-us-br'
        || !/^[a-f0-9]{40}$/u.test(source.sourceCommit) || source.sqlSha256 !== actualSqlSha256
        || verifiedAt !== snapshot.observedAt) return fail();
    return freeze({ schemaVersion: 1, operation: 'verify-child-signed-form-schema', verifiedAt,
        sourceCommit: source.sourceCommit, sqlSha256: source.sqlSha256, target: { ...snapshot.target },
        capability: snapshot.capability, runtimeGrantProfile: 'google-apple-parent-signed',
        schemaSha256: snapshot.schemaSha256, grantsSha256: snapshot.grantsSha256 });
}
