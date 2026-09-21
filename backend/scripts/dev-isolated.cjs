#!/usr/bin/env node
/** Persistent local-only backend: never reuses the production proxy or credentials. */
const { randomBytes, randomUUID } = require('node:crypto');
const { readFileSync, writeFileSync, existsSync, lstatSync, chmodSync } = require('node:fs');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createServer } = require('node:net');
const path = require('node:path');

const backend = path.resolve(__dirname, '..');
const repository = path.resolve(backend, '..');
const credentialsPath = path.join(repository, '.env.isolated.local');
const image = 'mysql:8.0.31@sha256:3d7ae561cf6095f6aca8eb7830e1d14734227b1fb4748092f2be2cfbccf7d614';
const containerName = 'ludolume-dev-mysql';
const databaseName = 'ludolume_development';
const runtimeUser = 'ludolume_dev';
const host = '127.0.0.1';
const port = 3307;
const execute = promisify(execFile);

class LocalDevelopmentError extends Error {}
function requireLocal(condition, message) {
    if (!condition) throw new LocalDevelopmentError(message);
}

function loadCredentials(containerExists) {
    if (!existsSync(credentialsPath)) {
        requireLocal(!containerExists, 'Local container exists but its credentials file is missing; refusing to reset either.');
        writeFileSync(credentialsPath, JSON.stringify({ version: 1, instanceId: randomUUID(),
            rootPassword: randomBytes(32).toString('hex'), runtimePassword: randomBytes(32).toString('hex'),
            sessionSecret: randomBytes(48).toString('hex') }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    const credentialFile = lstatSync(credentialsPath);
    requireLocal(credentialFile.isFile() && !credentialFile.isSymbolicLink() && credentialFile.size < 4096,
        'The local credentials file must be a small regular file, not a symbolic link.');
    const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    requireLocal(credentials.version === 1 && /^[a-f0-9-]{36}$/.test(credentials.instanceId)
        && /^[a-f0-9]{64}$/.test(credentials.rootPassword) && /^[a-f0-9]{64}$/.test(credentials.runtimePassword)
        && /^[a-f0-9]{96}$/.test(credentials.sessionSecret), 'Local credentials are malformed; refusing to overwrite them.');
    try { chmodSync(credentialsPath, 0o600); } catch { /* Windows ACLs may not support POSIX modes. */ }
    return credentials;
}

function parseArguments(args) {
    if (args.length === 0) return Object.freeze({});
    requireLocal((args.length === 2 || (args.length === 3 && args[2] === '--google-signup')) && args[0] === '--google-web-client-id',
        'Usage: npm run backend:dev:isolated -- [--google-web-client-id <client-id> [--google-signup]]');
    const googleWebClientId = args[1];
    requireLocal(typeof googleWebClientId === 'string' && googleWebClientId.length <= 255
        && googleWebClientId === googleWebClientId.trim()
        && /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(googleWebClientId),
    'The Google web client ID must be one exact apps.googleusercontent.com identifier without whitespace.');
    return Object.freeze({ googleWebClientId, ...(args.length === 3 ? { googleSignup: true } : {}) });
}

function runtimeEnvironment(credentials, inherited = process.env, options = {}) {
    const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
        !/^(?:DB_|MIGRATION_|SESSION_|ACCOUNT_|PROVIDER_|GOOGLE_|APPLE_|GCLOUD_|CLOUD_|FIREBASE_|P4_|THREE_|NODE_OPTIONS$)/i.test(key)));
    return { ...env, NODE_ENV: 'development', LUDOLUME_ISOLATED_RUNTIME: 'true',
        BACKEND_PORT: '8080', DB_HOST: host, DB_PORT: String(port),
        DB_NAME: databaseName, DB_USER: runtimeUser, DB_PASS: credentials.runtimePassword,
        SESSION_SECRET: credentials.sessionSecret, ACCOUNT_DELETION_ENABLED: 'false',
        PROVIDER_AUTH_ENABLED: options.googleWebClientId === undefined ? 'false' : 'true',
        PROVIDER_GOOGLE_SIGNUP_ENABLED: options.googleWebClientId !== undefined && options.googleSignup === true ? 'true' : 'false',
        ...(options.googleWebClientId === undefined ? {} : { GOOGLE_WEB_CLIENT_ID: options.googleWebClientId }),
        P4_VEGA_SCORE_SUBMISSIONS_ENABLED: 'true', THREE_BOSSES_RUN_SUBMISSIONS_ENABLED: 'true' };
}

function localProviderGrantStatements(options = {}) {
    if (options.googleWebClientId === undefined) return Object.freeze([]);
    // Kept local-only: production's reviewed runtime grant manifest is unchanged.
    // FOR UPDATE needs a write privilege; only the non-identity timestamp is updatable.
    return Object.freeze([
        `GRANT SELECT (\`provider\`, \`subject\`, \`account_uuid\`),
            INSERT (\`provider\`, \`subject\`, \`account_uuid\`, \`linked_at\`), UPDATE (\`linked_at\`)
            ON \`${databaseName}\`.\`account_provider_identities\` TO '${runtimeUser}'@'%';`,
        `GRANT SELECT (\`state_hash\`, \`binding_hash\`, \`nonce\`, \`client_key\`, \`action\`, \`user_id\`, \`account_uuid\`, \`expires_at\`),
            INSERT (\`state_hash\`, \`binding_hash\`, \`nonce\`, \`client_key\`, \`action\`, \`user_id\`, \`account_uuid\`, \`expires_at\`), DELETE
            ON \`${databaseName}\`.\`provider_auth_attempts\` TO '${runtimeUser}'@'%';`,
    ]);
}

async function assertFreePort(candidate) {
    await new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', () => reject(new LocalDevelopmentError(`Port ${candidate} is occupied; stop the conflicting local service first.`)));
        server.listen(candidate, host, () => server.close(resolve));
    });
}

async function docker(args, context, extraEnvironment = {}) {
    try {
        const result = await execute('docker', [...(context ? ['--context', context] : []), ...args],
            { cwd: repository, env: { ...process.env, ...extraEnvironment }, windowsHide: true,
                timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
        return result.stdout.trim();
    } catch {
        // Docker inspection/environment errors can contain passwords; never forward raw output.
        throw new LocalDevelopmentError(`Docker ${args[0]} failed. Check Docker Desktop and the selected local context.`);
    }
}

function validateContainer(container, credentials) {
    const bindings = container.HostConfig?.PortBindings;
    const mapped = bindings?.['3306/tcp'];
    const published = container.NetworkSettings?.Ports?.['3306/tcp'];
    requireLocal(container.Name === `/${containerName}` && container.Config?.Image === image
        && container.Config?.Labels?.['com.ludolume.development'] === 'isolated-backend-v1'
        && container.Config?.Labels?.['com.ludolume.instance'] === credentials.instanceId
        && container.HostConfig?.AutoRemove === false && container.HostConfig?.Privileged === false
        && !['host', 'container'].some(mode => container.HostConfig?.NetworkMode?.startsWith(mode))
        && Object.keys(bindings ?? {}).length === 1 && mapped?.length === 1
        && mapped[0].HostIp === host && mapped[0].HostPort === String(port)
        && (!container.State?.Running || (published?.length === 1
            && published[0].HostIp === host && published[0].HostPort === String(port)))
        && (container.Mounts ?? []).every(mount => mount.Type === 'volume' && mount.Destination === '/var/lib/mysql'),
    'Container identity, image, mounts or loopback port binding differs from the isolated configuration; refusing to connect.');
    return container;
}

async function prepareContainer() {
    const context = await docker(['context', 'show']);
    const [contextInfo] = JSON.parse(await docker(['context', 'inspect', context]));
    requireLocal(/^(?:npipe:\/\/\/\/\.\/pipe\/|unix:\/\/\/)/.test(contextInfo?.Endpoints?.docker?.Host ?? ''),
        'This launcher requires a local Docker Desktop/Unix-socket context, never a remote TCP or SSH daemon.');
    const existing = await docker(['container', 'ls', '--all', '--filter', `name=^/${containerName}$`, '--format', '{{.ID}}'], context);
    const credentials = loadCredentials(Boolean(existing));
    if (!existing) {
        await assertFreePort(port);
        console.log(`Creating persistent isolated MySQL on ${host}:${port}; no production data is copied.`);
        await docker(['run', '--detach', '--name', containerName, '--publish', `${host}:${port}:3306`,
            '--label', 'com.ludolume.development=isolated-backend-v1', '--label', `com.ludolume.instance=${credentials.instanceId}`,
            '--env', 'MYSQL_ROOT_PASSWORD', '--env', 'MYSQL_ROOT_HOST=%', '--env', `MYSQL_DATABASE=${databaseName}`,
            image, '--skip-log-bin'], context, { MYSQL_ROOT_PASSWORD: credentials.rootPassword });
    }
    const inspect = async () => validateContainer(JSON.parse(await docker(['inspect', '--type', 'container', containerName], context))[0], credentials);
    let container = await inspect();
    if (!container.State?.Running) {
        await assertFreePort(port);
        await docker(['start', containerName], context);
        container = await inspect();
    }
    requireLocal(container.State?.Running === true, 'The isolated MySQL container is not running.');
    return { credentials, context, containerId: container.Id };
}

async function prepareDatabase({ credentials, context, containerId }, options) {
    require('ts-node').register({ project: path.join(backend, 'tsconfig.json') });
    const mysql = require('mysql2/promise');
    const { loadMigrationManifest } = require('../ts/migrations/migrationManifest');
    const { applyMigrations, planMigrations } = require('../ts/migrations/migrationRunner');
    const { renderRuntimeGrantStatements } = require('../ts/security/runtimeGrantManifest');
    const migrations = loadMigrationManifest(path.join(backend, 'migrations'));
    requireLocal(migrations.length === 18 && migrations.at(-1).version === '0018_add_apple_session_provenance',
        'The local bootstrap must be reviewed before applying migrations beyond 0018.');
    const connectionOptions = { host, port, user: 'root', password: credentials.rootPassword, database: databaseName,
        connectTimeout: 2000, multipleStatements: false, dateStrings: true, timezone: 'Z' };
    let connection;
    const deadline = Date.now() + 90_000;
    while (!connection && Date.now() < deadline) {
        try { connection = await mysql.createConnection(connectionOptions); }
        catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    requireLocal(connection, 'Isolated MySQL did not become ready; its container and data were retained.');
    try {
        const autoConfig = await docker(['exec', containerId, 'cat', '/var/lib/mysql/auto.cnf'], context);
        const uuid = /^server-uuid=([a-f0-9-]{36})$/im.exec(autoConfig)?.[1];
        const [identity] = await connection.query('SELECT DATABASE() AS db, CURRENT_USER() AS account, @@server_uuid AS uuid, @@version AS version');
        requireLocal(uuid && identity.length === 1 && identity[0].db === databaseName
            && identity[0].account === 'root@%' && identity[0].uuid === uuid && /^8\.0\.31(?:-|$)/.test(identity[0].version),
        'The connected database does not match the validated local container; refusing all writes.');
        const [tables] = await connection.query('SHOW TABLES');
        if (tables.length === 0) await connection.query(`CREATE TABLE users (
            user_id INT NOT NULL AUTO_INCREMENT, user_name VARCHAR(255) NOT NULL,
            email VARCHAR(255) NOT NULL, user_password VARCHAR(255) NOT NULL, p4_score INT NULL,
            PRIMARY KEY (user_id), UNIQUE KEY uq_users_email (email)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        const settings = { database: databaseName, advisoryLockTimeoutSeconds: 5, lockWaitTimeoutSeconds: 10 };
        for (const allowedEffectKinds of [['create-table'], ['drop-column'], ['detach-best-source', 'retain-receipts'],
            ['add-account-identity'], ['add-provider-identities'], ['add-provider-attempts'], ['add-account-sessions'], ['add-session-renewal'],
            ['add-unique-user-names'], ['allow-passwordless-accounts'], ['extend-provider-attempt-actions'],
            ['add-apple-tokens'], ['add-apple-revocations', 'add-apple-session-provenance']]) {
            await applyMigrations(connection, migrations, settings, { allowedEffectKinds });
        }
        requireLocal((await planMigrations(connection, migrations, settings)).pending.length === 0, 'Local schema setup is incomplete.');
        await connection.query(`CREATE USER IF NOT EXISTS '${runtimeUser}'@'%' IDENTIFIED BY ?`, [credentials.runtimePassword]);
        for (const sql of renderRuntimeGrantStatements(databaseName, { user: runtimeUser, host: '%' })) await connection.query(sql);
        for (const sql of localProviderGrantStatements(options)) await connection.query(sql);
        console.log(`Verified local database ${databaseName}; migrations 0001–0018 and restricted runtime grants are ready.`);
    } finally { await connection.end(); }
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    await assertFreePort(8080);
    const local = await prepareContainer();
    await prepareDatabase(local, options);
    // The isolated marker bypasses app.ts dotenv loading; all runtime values stay local.
    const env = runtimeEnvironment(local.credentials, process.env, options);
    console.log(options.googleWebClientId === undefined ? 'Provider sign-in is disabled.'
        : 'Google web sign-in is enabled only for this isolated backend; local provider grants are retained.');
    console.log('Building the initial local backend before starting its watcher/server.');
    await new Promise((resolve, reject) => {
        const build = spawn(process.execPath, [require.resolve('webpack-cli/bin/cli.js'), '--mode', 'development'],
            { cwd: backend, env, shell: false, windowsHide: true, stdio: 'inherit', timeout: 180_000 });
        const stop = () => build.kill('SIGTERM');
        const cleanup = () => {
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        build.once('error', () => { cleanup(); reject(new LocalDevelopmentError('Initial backend build could not start.')); });
        build.once('close', code => {
            cleanup();
            if (code === 0) resolve();
            else reject(new LocalDevelopmentError('Initial backend build did not complete; watch/server were not started.'));
        });
    });
    const { default: concurrently } = await import('concurrently');
    console.log('Starting isolated backend on port 8080. Ctrl+C stops watch/server; MySQL and local accounts are retained.');
    await concurrently([
        { command: 'npm run watch', name: 'watch', cwd: backend, env },
        { command: 'npm run dev', name: 'server', cwd: backend, env },
    ], { killOthersOn: ['failure', 'success'], killTimeout: 5000, prefix: 'name', prefixColors: ['magenta', 'red'] }).result;
}

if (require.main === module) main().catch(error => {
    console.error(error instanceof LocalDevelopmentError ? error.message
        : 'Isolated backend setup/runtime failed. Local data was retained; no production target was contacted.');
    process.exitCode = 1;
});

module.exports = { validateContainer, runtimeEnvironment, parseArguments, localProviderGrantStatements };
