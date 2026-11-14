import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic-only database. No production connection details are accepted.
export const IMAGE = 'mysql:8.0.31@sha256:3d7ae561cf6095f6aca8eb7830e1d14734227b1fb4748092f2be2cfbccf7d614';
export const DATABASE = 'mickeyf_age_binding_proof';
export const USER = 'age_proof';
export const PASSWORD = 'age-proof-test-only';
export const ROOT_PASSWORD = 'age-proof-root-test-only';
const CONTEXT = 'desktop-linux';
const LOCAL_ENDPOINT = 'npipe:////./pipe/dockerDesktopLinuxEngine';
const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(BACKEND, '..');
const TEST = 'ts/accounts/registrationBinding.integration.test.ts';
const ID = /^[a-f0-9]{64}$/u;
const NAME = /^ludolume-age-proof-[a-z0-9-]+$/u;

export function assertLocalContext(name, endpoint) {
    if (process.platform !== 'win32' || name !== CONTEXT || endpoint !== LOCAL_ENDPOINT) {
        throw new Error('AGE_PROOF_REQUIRES_LOCAL_WINDOWS_DOCKER_DESKTOP');
    }
}

export function inspectContainer(value, expectedId, expectedName) {
    const list = JSON.parse(value);
    if (!ID.test(expectedId) || !NAME.test(expectedName) || !Array.isArray(list) || list.length !== 1) throw new Error('INVALID_CONTAINER_INSPECTION');
    const item = list[0];
    const labels = item.Config?.Labels ?? {};
    const ports = item.NetworkSettings?.Ports?.['3306/tcp'];
    if (item.Id !== expectedId || item.Name !== `/${expectedName}` || item.Config?.Image !== IMAGE
        || labels['com.ludolume.purpose'] !== 'age-binding-proof'
        || labels['com.ludolume.owner'] !== expectedName || item.State?.Running !== true
        || item.HostConfig?.Privileged !== false || (item.Mounts?.length ?? -1) !== 0
        || JSON.stringify(item.HostConfig?.Tmpfs) !== JSON.stringify({ '/var/lib/mysql': 'rw,noexec,nosuid,size=512m' })
        || !Array.isArray(ports) || ports.length !== 1 || ports[0].HostIp !== '127.0.0.1'
        || !/^\d{1,5}$/u.test(ports[0].HostPort ?? '')
        || Number(ports[0].HostPort) < 1024 || Number(ports[0].HostPort) > 65535
        || Number(ports[0].HostPort) === 3306) throw new Error('UNEXPECTED_CONTAINER_CONFIGURATION');
    return Number(ports[0].HostPort);
}

export function testEnvironment(port, id, name, source = process.env) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3306) throw new Error('INVALID_TEST_PORT');
    if (!ID.test(id) || !NAME.test(name)) throw new Error('INVALID_TEST_CONTAINER');
    const env = Object.create(null);
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'ComSpec', 'TEMP', 'TMP', 'PATHEXT', 'USERPROFILE']) {
        if (typeof source[key] === 'string') env[key] = source[key];
    }
    return { ...env, NODE_ENV: 'test', AGE_BINDING_PROOF_TEST: '1', AGE_BINDING_PROOF_HOST: '127.0.0.1',
        AGE_BINDING_PROOF_PORT: String(port), AGE_BINDING_PROOF_DATABASE: DATABASE,
        AGE_BINDING_PROOF_USER: USER, AGE_BINDING_PROOF_PASSWORD: PASSWORD,
        AGE_BINDING_PROOF_CONTAINER_ID: id, AGE_BINDING_PROOF_CONTAINER_NAME: name };
}

function execute(binary, args, { cwd = REPO, env = process.env, capture = true, onStart } = {}) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(binary, args, { cwd, env, shell: false, windowsHide: true,
            stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
        onStart?.(child);
        const stdout = []; const stderr = [];
        if (capture) { child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk)); }
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolvePromise(Buffer.concat(stdout).toString('utf8').trim())
            : reject(new Error(`SYNTHETIC_PROCESS_FAILED (exit ${code})`)));
    });
}

export async function runProof({ run = execute, cancellation = { requested: false, testChild: undefined } } = {}) {
    const name = `ludolume-age-proof-${process.pid}-${randomBytes(8).toString('hex')}`;
    if (!NAME.test(name)) throw new Error('INVALID_CONTAINER_NAME');
    const docker = (...args) => run('docker', ['--context', CONTEXT, ...args]);
    const endpoint = await docker('context', 'inspect', CONTEXT, '--format', '{{.Endpoints.docker.Host}}');
    assertLocalContext(CONTEXT, endpoint);
    if (cancellation.requested) throw new Error('SYNTHETIC_TEST_INTERRUPTED');
    // --pull=never avoids silently fetching a different image or incurring a network dependency.
    const id = await docker('run', '--pull=never', '--detach', '--rm', '--name', name,
        '--label', 'com.ludolume.purpose=age-binding-proof', '--label', `com.ludolume.owner=${name}`,
        '-e', `MYSQL_DATABASE=${DATABASE}`, '-e', `MYSQL_USER=${USER}`, '-e', `MYSQL_PASSWORD=${PASSWORD}`,
        '-e', `MYSQL_ROOT_PASSWORD=${ROOT_PASSWORD}`, '--tmpfs', '/var/lib/mysql:rw,noexec,nosuid,size=512m',
        '-p', '127.0.0.1::3306', IMAGE);
    if (!ID.test(id)) throw new Error('INVALID_CREATED_CONTAINER_ID');
    let failure;
    try {
        if (cancellation.requested) throw new Error('SYNTHETIC_TEST_INTERRUPTED');
        const port = inspectContainer(await docker('inspect', '--type', 'container', id), id, name);
        if (cancellation.requested) throw new Error('SYNTHETIC_TEST_INTERRUPTED');
        await run(process.execPath, ['--test', '--test-timeout=120000', '-r', 'ts-node/register', TEST],
            { cwd: BACKEND, env: testEnvironment(port, id, name), capture: false,
                onStart: child => { cancellation.testChild = child; if (cancellation.requested) child.kill(); } });
    } catch (error) { failure = error; }
    finally {
        cancellation.testChild = undefined;
        try {
            // Never remove anything based solely on a computed name or stale ID.
            inspectContainer(await docker('inspect', '--type', 'container', id), id, name);
            await docker('rm', '--force', id);
        } catch (error) {
            if (failure) console.error(`AGE_PROOF_CLEANUP_ALSO_FAILED: ${error.message}`);
            else failure = error;
        }
    }
    if (failure) throw failure;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length !== 2) { console.error('No target arguments are accepted.'); process.exitCode = 1; }
    else {
        const cancellation = { requested: false, testChild: undefined, exitCode: 1 };
        const stop = code => { cancellation.requested = true; cancellation.exitCode = code; cancellation.testChild?.kill(); };
        const interrupt = () => stop(130);
        const terminate = () => stop(143);
        process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
        runProof({ cancellation }).catch(error => { console.error(error.message); process.exitCode = cancellation.exitCode; })
            .finally(() => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); });
    }
}
