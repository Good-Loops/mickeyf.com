import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertChildSchemaCleanSource, childSchemaCommandSettings, childSchemaPrerequisiteEnvironment,
    readChildSchemaPrerequisites, createChildSchemaConnection, runChildSignedFormSchema } from './runChildSignedFormSchema';
import { PRODUCTION_CLOUD_SQL_TARGET } from '../security/cloudSqlRuntimeRoleRemover';
import { loadMigrationConfig } from '../config/migrationConfig';

const source = 'a'.repeat(40);
const env = { MIGRATION_DB_HOST: '127.0.0.1', MIGRATION_DB_PORT: '13307', MIGRATION_DB_NAME: 'cms',
    MIGRATION_DB_USER: 'reviewed_owner', MIGRATION_DB_PASS: 'synthetic-password-not-production',
    MIGRATION_CONFIRM_DATABASE: 'cms', MIGRATION_CONFIRM_TARGET: '127.0.0.1:13307/cms',
    MIGRATION_CONFIRM_ACCOUNT: 'reviewed_owner@%', MIGRATION_CONFIRM_SERVER_UUID: PRODUCTION_CLOUD_SQL_TARGET.serverUuid,
    MIGRATION_CONFIRM_CLOUD_SQL_PROJECT: PRODUCTION_CLOUD_SQL_TARGET.project,
    MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE: PRODUCTION_CLOUD_SQL_TARGET.instance,
    MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME: PRODUCTION_CLOUD_SQL_TARGET.connectionName,
    MIGRATION_CONFIRM_SERVER_VERSION: '8.0.31-google', MIGRATION_CONFIRM_VERSION_COMMENT: 'synthetic reviewed vendor',
    CHILD_SIGNED_FORM_SOURCE_COMMIT: source };

test('privileged CLI settings bind exact proxy/database/admin/server/project/version/vendor and explicit source', () => {
    const settings = childSchemaCommandSettings(env);
    assert.equal(settings.settings.expectedCurrentUser, env.MIGRATION_CONFIRM_ACCOUNT);
    assert.equal(settings.settings.expectedServerVersion, env.MIGRATION_CONFIRM_SERVER_VERSION);
    for (const key of Object.keys(env)) {
        const missing = { ...env } as Record<string, string | undefined>;
        delete missing[key]; assert.throws(() => childSchemaCommandSettings(missing));
    }
    for (const fields of [
        { MIGRATION_DB_HOST: 'production-host' }, { MIGRATION_DB_NAME: 'other' }, { MIGRATION_CONFIRM_TARGET: '127.0.0.1:3306/cms' },
        { MIGRATION_CONFIRM_SERVER_UUID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, { MIGRATION_CONFIRM_CLOUD_SQL_PROJECT: 'other-project' },
        { MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE: 'other' }, { MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME: 'other' },
        { MIGRATION_DB_USER: 'cms_mickeyf', MIGRATION_CONFIRM_ACCOUNT: 'cms_mickeyf@%' }, { MIGRATION_CONFIRM_ACCOUNT: 'other@%' },
        { MIGRATION_CONFIRM_SERVER_VERSION: '8.0.32' }, { CHILD_SIGNED_FORM_SOURCE_COMMIT: 'main' },
    ]) assert.throws(() => childSchemaCommandSettings({ ...env, ...fields }));
});

test('clean source is actual exact HEAD plus no tracked/untracked drift, using fixed bounded git commands', () => {
    const calls: unknown[][] = [];
    const run = ((file: string, args: string[], options: any) => {
        calls.push([file, args, options]);
        assert.equal(file, 'git'); assert.equal(options.shell, false); assert.equal(options.timeout, 10_000);
        assert.deepEqual(options.env, { PATH: 'synthetic-bin' });
        return { status: 0, stdout: args[0] === 'rev-parse' ? `${source}\n` : '' };
    }) as any;
    assertChildSchemaCleanSource(source, run, { PATH: 'synthetic-bin', GIT_DIR: 'wrong-repository',
        GIT_WORK_TREE: 'wrong-tree', GIT_INDEX_FILE: 'wrong-index', GIT_CONFIG_COUNT: '1',
        NODE_OPTIONS: '--require unreviewed', MIGRATION_DB_PASS: 'private' });
    assert.equal(calls.length, 2);
    for (const result of [{ status: 1, stdout: '' }, { status: 0, stdout: 'b'.repeat(40) }, { error: new Error('private') }]) {
        assert.throws(() => assertChildSchemaCleanSource(source, (() => result) as any), /blocked/u);
    }
    let count = 0;
    assert.throws(() => assertChildSchemaCleanSource(source, (() => ({ status: 0,
        stdout: ++count === 1 ? source : '?? unreviewed-file' })) as any), /blocked/u);
});

test('authenticated cloud reader subprocess strips SQL credentials and inherited executable hooks', () => {
    const result = childSchemaPrerequisiteEnvironment({ ...env, Path: 'synthetic-bin', USERPROFILE: 'synthetic-user',
        CLOUDSDK_CONFIG: 'synthetic-auth-config', NODE_OPTIONS: '--require unreviewed', NODE_PATH: 'unreviewed',
        GOOGLE_APPLICATION_CREDENTIALS: 'unreviewed', DB_PASS: 'private', REGISTRATION_AUDIENCE: 'general' });
    assert.deepEqual(result, { Path: 'synthetic-bin', USERPROFILE: 'synthetic-user', CLOUDSDK_CONFIG: 'synthetic-auth-config' });
});

test('prerequisites execute only fixed reader with bounded reviewed pins and full approved plan on stdin', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'child-schema-cli-unit-'));
    const pins = path.join(directory, 'reviewed-pins.json');
    writeFileSync(pins, '{}');
    try {
        for (const approved of [undefined, { sha256: 'b'.repeat(64), operation: 'extend-child-signed-form-schema',
            releaseSafety: { synthetic: 'full reviewed proof' } }]) {
            let calls = 0;
            const run = ((file: string, args: string[], options: any) => {
                calls++; assert.equal(file, process.execPath); assert.match(args[0], /scripts[\\/]child-schema-verifier\.mjs$/u);
                assert.deepEqual(args.slice(1), ['prerequisites', pins, ...(approved ? ['--recheck-approved-plan', approved.sha256] : [])]);
                assert.equal(options.shell, false); assert.equal(options.timeout, approved ? 120_000 : 480_000);
                assert.equal(options.env.MIGRATION_DB_PASS, undefined);
                assert.equal(options.input, approved ? JSON.stringify(approved) : undefined);
                return { status: 0, stdout: '{"synthetic":"metadata"}' };
            }) as any;
            assert.deepEqual(readChildSchemaPrerequisites(pins, approved as any, env, run), { synthetic: 'metadata' });
            assert.equal(calls, 1);
        }
        for (const result of [{ status: 1, stdout: 'private details' }, { status: 0, stdout: 'not json' },
            { status: 0, stdout: '{}', error: new Error('private details') }]) {
            assert.throws(() => readChildSchemaPrerequisites(pins, undefined, env, (() => result) as any), /private process/u);
        }
        writeFileSync(pins, 'x'.repeat(131_073));
        assert.throws(() => readChildSchemaPrerequisites(pins, undefined, env, (() => { throw new Error('must not run'); }) as any), /blocked/u);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('dedicated MySQL connection is lazy and timed-out queries destroy public connection AND physical stream', async () => {
    const calls: string[] = [];
    let connected = 0;
    const session = createChildSchemaConnection(loadMigrationConfig(env), (async (options: any) => {
        connected++; assert.equal(options.multipleStatements, false); assert.equal(options.connectTimeout, 10_000);
        return { query: async (query: any) => {
            assert.equal(query.sql, 'SELECT 1'); assert(query.timeout > 0 && query.timeout <= 30_000);
            throw Object.assign(new Error('private driver detail'), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' });
        }, destroy() { calls.push('destroy'); }, connection: { stream: { destroy() { calls.push('physical destroy'); } } },
        end() { calls.push('end'); } } as any;
    }) as any);
    assert.equal(connected, 0);
    await assert.rejects(session.connection.query('SELECT 1'));
    assert.deepEqual(calls, ['destroy', 'physical destroy']);
    await assert.rejects(session.connection.query('ALTER TABLE unsafe'));
    await session.close(); assert.equal(connected, 1); assert(!calls.includes('end'));
});

test('command grammar rejects arbitrary SQL paths, commands and unbound boundary arguments before connections', async () => {
    for (const args of [[], ['apply'], ['verify', '--pins', 'file'], ['plan', '--sql', 'file'],
        ['apply', '--pins', 'file', '--boundary', 'unbound'], ['rollback'], ['plan', '--pins', '']]) {
        await assert.rejects(runChildSignedFormSchema(args, {}), /blocked/u);
    }
});
