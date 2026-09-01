import { spawn } from 'node:child_process';
import {
    runtimeDatabaseAccountName,
    type RuntimeDatabaseAccount,
} from './runtimeGrantManifest';
import type {
    RuntimeRoleRemovalContext,
    RuntimeRoleRemover,
} from './runtimeGrantOperations';

export const CLOUD_SQL_ROLE_REMOVAL_PROVIDER = 'google-cloud-sql-gcloud';

export class CloudSqlRoleRemovalIndeterminateError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CloudSqlRoleRemovalIndeterminateError';
    }
}

export const PRODUCTION_CLOUD_SQL_TARGET = Object.freeze({
    project: 'noted-reef-387021',
    region: 'us-central1',
    instance: 'cms-mickeyf',
    connectionName: 'noted-reef-387021:us-central1:cms-mickeyf',
    serverUuid: 'd1e6865c-ecad-11ee-a6b0-42010a400002',
});

export const INCOMPATIBLE_MAIN_BUILD_TRIGGER = Object.freeze({
    id: 'ef5a2981-95be-4f4d-af91-f997fde73356',
    name: 'main-push-mickeyf-com',
    region: 'global',
    repositoryOwner: 'Good-Loops',
    repositoryName: 'mickeyf.com',
    branchPattern: '^main$',
    filename: 'cloudbuild.yaml',
    includedFiles: Object.freeze(['backend/**', 'Dockerfile', 'cloudbuild.yaml', '.dockerignore']),
    serviceAccount:
        'projects/-/serviceAccounts/cloud-build@noted-reef-387021.iam.gserviceaccount.com',
});

export type ExternalCommand = Readonly<{
    executable: string;
    args: readonly string[];
    shell: false;
    windowsHide: true;
}>;

export type ExternalCommandRunner = (
    command: ExternalCommand,
    options: Readonly<{
        timeoutMs: number;
        signal?: AbortSignal;
    }>
) => Promise<string>;

const MAX_OUTPUT_BYTES = 1024 * 1024;

export function buildGcloudCommand(args: readonly string[]): ExternalCommand {
    if (process.platform === 'win32') {
        return Object.freeze({
            executable: process.env.ComSpec || 'cmd.exe',
            args: Object.freeze(['/d', '/v:off', '/s', '/c', 'gcloud.cmd', ...args]),
            shell: false as const,
            windowsHide: true as const,
        });
    }
    return Object.freeze({
        executable: 'gcloud',
        args: Object.freeze([...args]),
        shell: false as const,
        windowsHide: true as const,
    });
}

export function buildCloudSqlDescribeArgs(): readonly string[] {
    return Object.freeze([
        'sql',
        'instances',
        'describe',
        PRODUCTION_CLOUD_SQL_TARGET.instance,
        `--project=${PRODUCTION_CLOUD_SQL_TARGET.project}`,
        '--format=json',
        '--quiet',
    ]);
}

export function buildCloudSqlOperationsListArgs(): readonly string[] {
    return Object.freeze([
        'sql',
        'operations',
        'list',
        `--project=${PRODUCTION_CLOUD_SQL_TARGET.project}`,
        `--instance=${PRODUCTION_CLOUD_SQL_TARGET.instance}`,
        '--filter=status!=DONE',
        '--limit=100',
        '--format=json',
        '--quiet',
    ]);
}

export function buildMainTriggerDescribeArgs(): readonly string[] {
    return Object.freeze([
        'builds',
        'triggers',
        'describe',
        INCOMPATIBLE_MAIN_BUILD_TRIGGER.id,
        `--project=${PRODUCTION_CLOUD_SQL_TARGET.project}`,
        `--region=${INCOMPATIBLE_MAIN_BUILD_TRIGGER.region}`,
        '--format=json',
        '--quiet',
    ]);
}

export function buildCloudSqlRoleRemovalArgs(
    runtimeAccount: RuntimeDatabaseAccount
): readonly string[] {
    return Object.freeze([
        'sql',
        'users',
        'assign-roles',
        runtimeAccount.user,
        `--project=${PRODUCTION_CLOUD_SQL_TARGET.project}`,
        `--instance=${PRODUCTION_CLOUD_SQL_TARGET.instance}`,
        '--type=BUILT_IN',
        `--host=${runtimeAccount.host}`,
        '--database-roles=',
        '--revoke-existing-roles',
        '--quiet',
    ]);
}

export const runExternalCommand: ExternalCommandRunner = (
    command,
    { timeoutMs, signal }
) => new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
        shell: command.shell,
        windowsHide: command.windowsHide,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const finish = (error?: Error, output = ''): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(output);
    };
    const capture = (target: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
            child.kill();
            finish(new Error('gcloud output exceeded the reviewed limit'));
            return;
        }
        target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.once('error', (error) => finish(error));
    child.once('close', (code, terminationSignal) => {
        const diagnostic = Buffer.concat(stderr)
            .toString('utf8')
            .trim()
            .slice(-4_000);
        if (code === 0) {
            finish(undefined, Buffer.concat(stdout).toString('utf8'));
            return;
        }
        const termination = terminationSignal
            ? `signal ${terminationSignal}`
            : `code ${String(code)}`;
        finish(new Error(
            diagnostic
                ? `gcloud exited with ${termination}: ${diagnostic}`
                : `gcloud exited with ${termination}`
        ));
    });
    const timeout = setTimeout(() => {
        child.kill();
        finish(new Error(`gcloud exceeded the ${timeoutMs}ms operation deadline`));
    }, timeoutMs);
    timeout.unref();
});

export async function verifyProductionCloudSqlTarget(
    timeoutMs: number,
    signal?: AbortSignal,
    runner: ExternalCommandRunner = runExternalCommand
): Promise<void> {
    const output = await runner(buildGcloudCommand(buildCloudSqlDescribeArgs()), {
        timeoutMs,
        signal,
    });
    let instance: unknown;
    try {
        instance = JSON.parse(output);
    } catch {
        throw new Error('gcloud returned invalid Cloud SQL instance metadata');
    }
    const connectionName = (instance as { connectionName?: unknown })?.connectionName;
    const region = (instance as { region?: unknown })?.region;
    const name = (instance as { name?: unknown })?.name;
    const project = (instance as { project?: unknown })?.project;
    if (
        connectionName !== PRODUCTION_CLOUD_SQL_TARGET.connectionName
        || region !== PRODUCTION_CLOUD_SQL_TARGET.region
        || name !== PRODUCTION_CLOUD_SQL_TARGET.instance
        || project !== PRODUCTION_CLOUD_SQL_TARGET.project
) throw new Error('gcloud resolved a different Cloud SQL instance than the confirmed target');
}

export async function verifyNoCloudSqlOperationsInFlight(
    timeoutMs: number,
    signal?: AbortSignal,
    runner: ExternalCommandRunner = runExternalCommand
): Promise<void> {
    const output = await runner(
        buildGcloudCommand(buildCloudSqlOperationsListArgs()),
        { timeoutMs, signal }
    );
    let operations: unknown;
    try {
        operations = JSON.parse(output);
    } catch {
        throw new Error('gcloud returned invalid Cloud SQL operation metadata');
    }
    if (!Array.isArray(operations)) {
        throw new Error('gcloud returned unsupported Cloud SQL operation metadata');
    }
    const unfinishedCount = operations.filter((operation) =>
        (operation as { status?: unknown })?.status !== 'DONE').length;
    if (unfinishedCount > 0) {
        throw new Error(
            `Cloud SQL has ${unfinishedCount} unfinished operation(s); privileged apply is blocked`
        );
    }
}

export async function verifyIncompatibleMainTriggerDisabled(
    timeoutMs: number,
    signal?: AbortSignal,
    runner: ExternalCommandRunner = runExternalCommand
): Promise<void> {
    const output = await runner(
        buildGcloudCommand(buildMainTriggerDescribeArgs()),
        { timeoutMs, signal }
    );
    let trigger: unknown;
    try {
        trigger = JSON.parse(output);
    } catch {
        throw new Error('gcloud returned invalid Cloud Build trigger metadata');
    }

    const observed = trigger as {
        id?: unknown;
        name?: unknown;
        disabled?: unknown;
        filename?: unknown;
        includedFiles?: unknown;
        serviceAccount?: unknown;
        github?: {
            owner?: unknown;
            name?: unknown;
            push?: { branch?: unknown };
        };
    };
    if (
        observed.id !== INCOMPATIBLE_MAIN_BUILD_TRIGGER.id
        || observed.name !== INCOMPATIBLE_MAIN_BUILD_TRIGGER.name
        || observed.disabled !== true
        || observed.filename !== INCOMPATIBLE_MAIN_BUILD_TRIGGER.filename
        || JSON.stringify(observed.includedFiles)
            !== JSON.stringify(INCOMPATIBLE_MAIN_BUILD_TRIGGER.includedFiles)
        || observed.serviceAccount !== INCOMPATIBLE_MAIN_BUILD_TRIGGER.serviceAccount
        || observed.github?.owner !== INCOMPATIBLE_MAIN_BUILD_TRIGGER.repositoryOwner
        || observed.github?.name !== INCOMPATIBLE_MAIN_BUILD_TRIGGER.repositoryName
        || observed.github?.push?.branch !== INCOMPATIBLE_MAIN_BUILD_TRIGGER.branchPattern
    ) {
        throw new Error(
            'The pinned incompatible main Cloud Build trigger is not exactly disabled'
        );
    }
}

function assertRemovalContext(
    context: RuntimeRoleRemovalContext,
    runtimeAccount: RuntimeDatabaseAccount,
    approvedRole: RuntimeDatabaseAccount
): void {
    if (
        context.provider !== CLOUD_SQL_ROLE_REMOVAL_PROVIDER
        || context.target !== PRODUCTION_CLOUD_SQL_TARGET.connectionName
        || runtimeDatabaseAccountName(context.runtimeAccount)
            !== runtimeDatabaseAccountName(runtimeAccount)
        || runtimeDatabaseAccountName(context.approvedRole)
            !== runtimeDatabaseAccountName(approvedRole)
    ) throw new Error('Runtime role-removal context differs from the approved Cloud SQL target');
}

export function createProductionCloudSqlRoleRemover(
    runtimeAccount: RuntimeDatabaseAccount,
    approvedRole: RuntimeDatabaseAccount,
    timeoutMs: number,
    signal?: AbortSignal,
    runner: ExternalCommandRunner = runExternalCommand
): RuntimeRoleRemover {
    return async (context) => {
        assertRemovalContext(context, runtimeAccount, approvedRole);
        await verifyNoCloudSqlOperationsInFlight(timeoutMs, signal, runner);
        try {
            await runner(buildGcloudCommand(buildCloudSqlRoleRemovalArgs(runtimeAccount)), {
                timeoutMs,
                signal,
            });
        } catch (error) {
            const detail = error instanceof Error
                ? error.message
                : 'unknown gcloud failure';
            throw new CloudSqlRoleRemovalIndeterminateError(
                'Cloud SQL role-removal outcome is indeterminate; inspect Cloud SQL '
                + `operations before retrying: ${detail}`
            );
        }
    };
}
