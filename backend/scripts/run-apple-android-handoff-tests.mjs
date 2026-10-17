import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_DIRECTORY = resolve(BACKEND_DIRECTORY, '..');
const COMPOSE_FILE = resolve(REPOSITORY_DIRECTORY, 'compose.migration-test.yaml');
export const MYSQL_IMAGE = 'mysql:8.0.31@sha256:3d7ae561cf6095f6aca8eb7830e1d14734227b1fb4748092f2be2cfbccf7d614';
export const TEST_COMMAND = Object.freeze({ executable: process.execPath,
    args: Object.freeze(['--test', '--test-timeout=120000', '-r', 'ts-node/register',
        'ts/auth/appleAndroidHandoffRepository.integration.test.ts']) });

export const dockerExecutable = platform => platform === 'win32' ? 'docker.exe' : 'docker';

export function isolatedEnvironment(inherited) {
    // Tests need OS/Docker discovery, not runtime DB credentials, Node preloads or Compose overrides.
    const allowed = /^(?:PATH|PATHEXT|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|SYSTEMROOT|WINDIR|COMSPEC|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|LANG|LC_ALL|TZ|CI|DOCKER_CONFIG|DOCKER_CONTEXT)$/iu;
    return { ...Object.fromEntries(Object.entries(inherited).filter(([key]) => allowed.test(key))),
        COMPOSE_DISABLE_ENV_FILE: '1' };
}

export function assertLocalDockerEndpoint(endpoint) {
    if (typeof endpoint !== 'string' || !(/^unix:\/\/\/[^\0\r\n]+$/u.test(endpoint)
        || /^npipe:\/{4}\.\/pipe\/[A-Za-z0-9_.-]+$/u.test(endpoint))) {
        throw new Error('LOCAL_DOCKER_REQUIRED');
    }
}

export function verifyContainer(inspections, project, id) {
    const container = Array.isArray(inspections) && inspections.length === 1 ? inspections[0] : null;
    const labels = container?.Config?.Labels;
    const ports = container?.NetworkSettings?.Ports?.['3306/tcp'];
    const port = Array.isArray(ports) && ports.length === 1 ? ports[0] : null;
    if (!/^[a-f0-9]{64}$/u.test(id) || container?.Id !== id || container?.Config?.Image !== MYSQL_IMAGE
        || labels?.['com.docker.compose.project'] !== project || labels?.['com.docker.compose.service'] !== 'mysql'
        || labels?.['com.mickeyf.purpose'] !== 'migration-test' || labels?.['com.mickeyf.scope'] !== 'local-test-only'
        || container?.State?.Running !== true || container?.State?.Health?.Status !== 'healthy'
        || port?.HostIp !== '127.0.0.1' || typeof port?.HostPort !== 'string' || !/^[1-9][0-9]{0,4}$/u.test(port.HostPort)
        || Number(port.HostPort) > 65535 || port.HostPort === '3306') {
        throw new Error('ISOLATED_MYSQL_IDENTITY_REQUIRED');
    }
    return port.HostPort;
}

export function runProcess(executable, args, { cwd, env, timeoutMs, signal, maxBytes = 1024 * 1024 }) {
    return new Promise((resolvePromise, reject) => {
        if (signal?.aborted) { reject(new Error('TEST_RUN_CANCELLED')); return; }
        const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = [];
        let size = 0;
        let stopped;
        const stop = code => { stopped ??= code; child.kill('SIGKILL'); };
        const abort = () => stop('TEST_RUN_CANCELLED');
        const deadline = setTimeout(() => stop('COMMAND_DEADLINE'), timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
            size += chunk.length;
            if (size > maxBytes) stop('COMMAND_OUTPUT_LIMIT');
            else chunks.push(chunk);
        });
        const finish = (error, code) => {
            clearTimeout(deadline);
            signal?.removeEventListener('abort', abort);
            const output = Buffer.concat(chunks).toString('utf8');
            if (error || stopped || code !== 0) {
                reject(Object.assign(new Error(stopped ?? (error ? 'COMMAND_START_FAILED' : 'COMMAND_FAILED')), { output }));
            } else resolvePromise(output);
        };
        child.once('error', error => finish(error));
        child.once('close', code => finish(null, code));
    });
}

export async function runHandoffTests({ run = runProcess, environment = process.env, platform = process.platform,
    signal, report = console.log } = {}) {
    // A remote daemon could publish its loopback port on another machine.
    if (Object.keys(environment).some(key => /^DOCKER_HOST$/iu.test(key))) throw new Error('DOCKER_HOST_OVERRIDE_FORBIDDEN');
    let env = isolatedEnvironment(environment);
    const docker = dockerExecutable(platform);
    const dockerHost = [];
    const project = `mickeyf-apple-handoff-${process.pid}-${randomBytes(6).toString('hex')}`;
    const compose = ['compose', '--project-name', project, '--file', COMPOSE_FILE];
    const deadline = Date.now() + 300_000;
    const invoke = (executable, args, options = {}) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('TEST_RUN_DEADLINE');
        return run(executable, args, { cwd: REPOSITORY_DIRECTORY, env, signal,
            timeoutMs: Math.min(120_000, remaining), ...options });
    };
    let started = false;
    let failure;
    let port;
    try {
        const endpoint = JSON.parse(await invoke(docker, ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']));
        assertLocalDockerEndpoint(endpoint);
        // A concurrent context switch must not redirect creation, inspection or cleanup.
        dockerHost.push('--host', endpoint);
        env = Object.fromEntries(Object.entries(env).filter(([key]) => !/^DOCKER_CONTEXT$/iu.test(key)));
        if ((await invoke(docker, [...dockerHost, ...compose, 'ps', '--all', '--quiet'])).trim()) throw new Error('DISPOSABLE_PROJECT_NOT_EMPTY');
        started = true;
        await invoke(docker, [...dockerHost, ...compose, 'up', '--detach', '--wait', '--wait-timeout', '90', '--pull', 'never', 'mysql']);
        const id = (await invoke(docker, [...dockerHost, ...compose, 'ps', '--quiet', 'mysql'])).trim();
        if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('ISOLATED_MYSQL_IDENTITY_REQUIRED');
        port = verifyContainer(JSON.parse(await invoke(docker, [...dockerHost, 'inspect', '--type', 'container', id])), project, id);
        report(`Verified fresh isolated MySQL on 127.0.0.1:${port}.`);
        const testEnv = { ...env, NODE_ENV: 'test', APPLE_ANDROID_HANDOFF_TEST_ENABLED: '1',
            APPLE_ANDROID_HANDOFF_TEST_CONTAINER: id, APPLE_ANDROID_HANDOFF_TEST_PORT: port };
        try {
            report(await invoke(TEST_COMMAND.executable, TEST_COMMAND.args, { cwd: BACKEND_DIRECTORY, env: testEnv,
                timeoutMs: Math.min(180_000, deadline - Date.now()) }));
        } catch (error) {
            if (typeof error.output === 'string') report(error.output);
            throw error;
        }
    } catch (error) { failure = error; }
    finally {
        if (started) {
            try {
                // Cleanup has its own deadline and remains possible after cancellation or test timeout.
                await run(docker, [...dockerHost, ...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '30'],
                    { cwd: REPOSITORY_DIRECTORY, env, timeoutMs: 45_000 });
                report('Disposable MySQL cleanup completed.');
            } catch { failure = new Error('DISPOSABLE_MYSQL_CLEANUP_FAILED'); }
        }
    }
    if (failure) throw failure;
    return { project, port };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    if (process.argv.length !== 2) {
        console.error('Usage: node backend/scripts/run-apple-android-handoff-tests.mjs');
        process.exitCode = 1;
    } else {
        runHandoffTests({ signal: controller.signal }).catch(error => {
            console.error(error.message);
            process.exitCode = 1;
        }).finally(() => {
            process.removeListener('SIGINT', abort);
            process.removeListener('SIGTERM', abort);
        });
    }
}
