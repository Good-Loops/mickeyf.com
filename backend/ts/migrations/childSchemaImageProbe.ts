import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { Connection, RowDataPacket } from 'mysql2/promise';

const execute = promisify(execFile);
const IMAGE = 'us-central1-docker.pkg.dev/noted-reef-387021/cloud-run-source-deploy/cloud-run-source-deploy@sha256:1bb849217045edb86764177a10014d366f230f3e249c881cf91a984574148360';
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|SYSTEMROOT|WINDIR|COMSPEC|DOCKER_CONFIG)$/iu.test(key)));

/** Real unmodified image startup, isolated from the network and production secrets. */
export async function probeChildSchemaImage(admin: Connection, schema: 'legacy' | 'extended'): Promise<void> {
    if (process.env.CHILD_SCHEMA_IMAGE_TEST !== '1') return;
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.CHILD_SCHEMA_RUNTIME_IMAGE, IMAGE);
    assert.equal(process.env.CHILD_SCHEMA_TEST_ENABLED, '1');
    const mysqlId = process.env.CHILD_SCHEMA_TEST_CONTAINER ?? '';
    assert.match(mysqlId, /^[a-f0-9]{64}$/u);
    const endpoint = JSON.parse((await execute(docker, ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'],
        { env: inherited, timeout: 10_000, windowsHide: true })).stdout);
    assert.match(endpoint, /^(?:npipe:\/{4}\.\/pipe\/[A-Za-z0-9_.-]+|unix:\/\/\/[^\0\r\n]+)$/u);
    const invoke = async (args: string[]) => (await execute(docker, ['--host', endpoint, ...args],
        { env: inherited, timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout.trim();
    const [mysql] = JSON.parse(await invoke(['inspect', '--type', 'container', mysqlId]));
    assert.equal(mysql.Id, mysqlId);
    assert.equal(mysql.Config.Labels['com.mickeyf.scope'], 'local-test-only');
    assert.equal(mysql.Config.Labels['com.mickeyf.purpose'], 'migration-test');
    assert.equal(mysql.State.Health.Status, 'healthy');
    const socket = mysql.Mounts.find((mount: { Destination: string }) => mount.Destination === '/var/run/mysqld');
    assert.equal(socket?.Type, 'volume');
    assert.match(socket.Name, /^mickeyf-apple-handoff-[a-z0-9-]+_schema-image-socket$/u);
    const [volume] = JSON.parse(await invoke(['volume', 'inspect', socket.Name]));
    assert.equal(volume.Labels['com.mickeyf.purpose'], 'child-schema-image-test');
    assert.equal(volume.Labels['com.docker.compose.project'], mysql.Config.Labels['com.docker.compose.project']);
    const [[identity]] = await admin.query<RowDataPacket[]>(`SELECT DATABASE() AS db, @@server_uuid AS serverUuid,
        (SELECT DATE_FORMAT(applied_at, '%Y-%m-%d %H:%i:%s.%f') FROM schema_migrations
         WHERE version='0008_finalize_account_identity') AS epoch`);
    assert.equal(identity.db, 'mickeyf_migration_test');
    const [image] = JSON.parse(await invoke(['image', 'inspect', IMAGE]));
    assert(image.RepoDigests.includes(IMAGE));
    for (const enabled of [false, true]) {
        const name = `ludolume-schema-image-${randomUUID()}`;
        const owner = randomUUID();
        const environment = syntheticEnvironment(identity, enabled);
        let id: string | undefined;
        try {
            id = await invoke(['create', '--pull=never', '--name', name, '--label', `com.mickeyf.probe=${owner}`,
                '--label', `com.mickeyf.schema-project=${mysql.Config.Labels['com.docker.compose.project']}`,
                '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                '--user=1000:1000', '--mount', `type=volume,source=${socket.Name},target=/cloudsql,readonly`,
                ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), IMAGE]);
            assert.match(id, /^[a-f0-9]{64}$/u);
            const [container] = JSON.parse(await invoke(['inspect', '--type', 'container', id]));
            assert.equal(container.Image, image.Id);
            assert.equal(container.HostConfig.NetworkMode, 'none');
            assert.equal(container.HostConfig.ReadonlyRootfs, true);
            assert.equal(container.Config.Labels['com.mickeyf.probe'], owner);
            await invoke(['start', id]);
            const shouldStart = schema === 'extended' || !enabled;
            let logs = '';
            const deadline = Date.now() + 25_000;
            while (Date.now() < deadline) {
                // Docker sends application stderr to its own stderr; collect both.
                const result = await execute(docker, ['--host', endpoint, 'logs', id],
                    { env: inherited, timeout: 10_000, maxBuffer: 256_000, windowsHide: true });
                logs = result.stdout + result.stderr;
                const state = JSON.parse(await invoke(['inspect', '--format', '{{json .State}}', id]));
                if (logs.includes('Backend listening') || !state.Running) break;
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            if (!shouldStart) {
                assert(!logs.includes('Backend listening'), 'legacy schema must reject enabled child creation');
                assert.match(logs, /Backend startup failed/u);
                const state = JSON.parse(await invoke(['inspect', '--format', '{{json .State}}', id]));
                assert.equal(state.Running, false);
                assert.equal(state.ExitCode, 1);
            } else {
                assert(logs.includes('Backend listening'), `image did not start: ${logs.slice(-2000)}`);
                const probe = `const r=await fetch('http://127.0.0.1:8080/auth/parent-registration/config');if(r.status!==200)throw Error('CONFIG_STATUS_'+r.status);console.log(JSON.stringify(await r.json()));`;
                const config = JSON.parse(await invoke(['exec', id, 'node', '--input-type=module', '-e', probe]));
                assert.equal(config.creationEnabled, enabled);
                assert.deepEqual(config.signedFormCountries, ['BR', 'US']);
                assert.equal(typeof config.signedFormVersion, 'string');
            }
            console.log(`Exact image ${schema} schema, creation ${enabled ? 'enabled' : 'closed'}: ${shouldStart ? 'HTTP ready' : 'startup rejected as expected'}.`);
        } finally {
            if (id) {
                const [owned] = JSON.parse(await invoke(['inspect', '--type', 'container', id]));
                assert.equal(owned.Config.Labels['com.mickeyf.probe'], owner);
                await invoke(['rm', '--force', id]);
            }
        }
    }
}

function syntheticEnvironment(identity: RowDataPacket, enabled: boolean): Record<string, string> {
    return {
        NODE_ENV: 'production', BACKEND_PORT: '8080', SESSION_SECRET: 'synthetic-local-rehearsal-secret-not-for-use',
        DB_NAME: 'mickeyf_migration_test', DB_USER: 'cms_mickeyf', DB_PASS: 'synthetic-runtime-only',
        CLOUD_SQL_CONNECTION_NAME: 'mysqld.sock',
        ACCOUNT_DELETION_ENABLED: 'true', ACCOUNT_DELETION_JOURNAL_BUCKET: 'ludolume-deletion-journal-1012884798546',
        ACCOUNT_IDENTITY_EPOCH: identity.epoch,
        PROVIDER_AUTH_ENABLED: 'true', GOOGLE_WEB_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
        PROVIDER_GOOGLE_SIGNUP_ENABLED: 'false', PROVIDER_APPLE_SIGNUP_ENABLED: 'false',
        APPLE_MAINTENANCE_HTTP_ENABLED: 'true', APPLE_MAINTENANCE_CALLER_SUBJECT: '123456789',
        APPLE_MAINTENANCE_EXPECTED_SERVER_UUID: identity.serverUuid, APPLE_TOKEN_RUNTIME_SECRETS_ENABLED: 'true',
        REGISTRATION_ENABLED: 'true', REGISTRATION_CREATION_ENABLED: 'false', REGISTRATION_POLICY_REVIEWED: 'true',
        REGISTRATION_AUDIENCE: 'children-included', REGISTRATION_POLICY_VERSION: 'synthetic-image-test',
        REGISTRATION_COUNTRY_RULES: JSON.stringify({ US: { parentRequiredBelow: 13 }, BR: { parentRequiredBelow: 18 } }),
        PARENT_REGISTRATION_ENABLED: 'true', PARENT_REGISTRATION_POLICY_REVIEWED: 'true',
        PARENT_REGISTRATION_CREATION_ENABLED: String(enabled), PARENT_SIGNED_FORMS_ENABLED: 'true',
        PARENT_REGISTRATION_POLICY_VERSION: 'synthetic-image-test', PARENT_CONSENT_VERSION: 'synthetic-image-test',
        PARENT_CONSENT_TEXT: 'Synthetic local schema test, not real parental consent.',
        PARENT_PRIVACY_NOTICE_URL: 'https://mickeyf.com/privacy',
        PARENT_REGISTRATION_COUNTRIES: '["BR","US"]', PARENT_SIGNED_FORM_COUNTRIES: '["BR","US"]',
    };
}
