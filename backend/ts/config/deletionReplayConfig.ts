type Environment = Readonly<Record<string, string | undefined>>;

export const DELETION_REPLAY_FREEZE_ACK = 'public-traffic-and-account-writes-stopped';
export const DELETION_REPLAY_RECOVERY_ACK = 'isolated-restore-and-session-rotation-required';

export type DeletionReplaySettings = Readonly<{
    mode: 'active' | 'recovery';
    database: string;
    expectedCurrentUser: string;
    expectedServerUuid: string;
    expectedIdentityEpoch: string;
    sourceServerUuid?: string;
    maxIntents: number;
    maxDurationMs: number;
}>;

export type DeletionReplayConfig = Readonly<{
    operation: 'plan' | 'apply';
    approvedPlanSha256?: string;
    connection: Readonly<{ host: '127.0.0.1'; port: number; database: string; user: string; password: string }>;
    settings: DeletionReplaySettings;
}>;

function required(env: Environment, name: string): string {
    const value = env[name];
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`Missing ${name}`);
    return value;
}

function integer(value: string, name: string, maximum: number): number {
    if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`Invalid ${name}`);
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result > maximum) throw new Error(`Invalid ${name}`);
    return result;
}

function uuid(value: string, name: string): string {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value)) throw new Error(`Invalid ${name}`);
    return value;
}

/** Only dedicated variables are accepted; ordinary application DB settings are never a fallback. */
export function loadDeletionReplayConfig(
    args: readonly string[], env: Environment = process.env
): DeletionReplayConfig {
    const operation = args[0];
    if (args.length !== 1 || (operation !== 'plan' && operation !== 'apply')) {
        throw new Error('Usage: deletion replay plan|apply');
    }
    const mode = required(env, 'DELETION_REPLAY_MODE');
    if (mode !== 'active' && mode !== 'recovery') throw new Error('Invalid DELETION_REPLAY_MODE');
    // These are operator attestations, not technical proof of isolation or stopped traffic.
    if (env.DELETION_REPLAY_FREEZE_ACK !== DELETION_REPLAY_FREEZE_ACK) {
        throw new Error('Deletion replay requires the traffic/account-write freeze acknowledgement');
    }
    if (mode === 'recovery' && env.DELETION_REPLAY_RECOVERY_ACK !== DELETION_REPLAY_RECOVERY_ACK) {
        throw new Error('Recovery requires the isolation and session-rotation acknowledgement');
    }
    if (required(env, 'DELETION_REPLAY_DB_HOST') !== '127.0.0.1') {
        throw new Error('Deletion replay requires an explicit loopback database connection');
    }
    const database = required(env, 'DELETION_REPLAY_DB_NAME');
    const user = required(env, 'DELETION_REPLAY_DB_USER');
    if (!/^[A-Za-z0-9_]{1,64}$/u.test(database) || !/^[A-Za-z0-9_.-]{1,32}$/u.test(user)) {
        throw new Error('Invalid deletion replay database or maintenance user');
    }
    const expectedCurrentUser = required(env, 'DELETION_REPLAY_DB_CURRENT_USER');
    if (!expectedCurrentUser.startsWith(`${user}@`) || !/^[A-Za-z0-9_.%-]+@[A-Za-z0-9_.:%/~\-]+$/u.test(expectedCurrentUser)) {
        throw new Error('Deletion replay requires the exact maintenance CURRENT_USER');
    }
    const expectedServerUuid = uuid(required(env, 'DELETION_REPLAY_DB_SERVER_UUID'), 'target server UUID');
    const expectedIdentityEpoch = required(env, 'DELETION_REPLAY_IDENTITY_EPOCH');
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u.test(expectedIdentityEpoch)) {
        throw new Error('Identity epoch must be the independently recorded original UTC timestamp with six fractional digits');
    }
    const epochDate = new Date(`${expectedIdentityEpoch.slice(0, 10)}T${expectedIdentityEpoch.slice(11, 23)}Z`);
    if (!Number.isFinite(epochDate.getTime()) || epochDate.toISOString().replace('T', ' ').slice(0, 23) !== expectedIdentityEpoch.slice(0, 23)) {
        throw new Error('Invalid deletion replay identity epoch');
    }
    const sourceServerUuid = mode === 'recovery'
        ? uuid(required(env, 'DELETION_REPLAY_SOURCE_SERVER_UUID'), 'source server UUID')
        : undefined;
    if (sourceServerUuid === expectedServerUuid) throw new Error('Recovery target must differ from the original source server');
    if (mode === 'active' && env.DELETION_REPLAY_SOURCE_SERVER_UUID !== undefined) {
        throw new Error('Active replay must not declare a recovery source');
    }
    const approvedPlanSha256 = env.DELETION_REPLAY_APPROVED_PLAN_SHA256;
    if (operation === 'apply' && !/^[0-9a-f]{64}$/u.test(approvedPlanSha256 ?? '')) {
        throw new Error('Apply requires a reviewed deletion replay plan digest');
    }
    if (operation === 'plan' && approvedPlanSha256 !== undefined) {
        throw new Error('Plan must not include an apply approval');
    }
    return Object.freeze({
        operation, approvedPlanSha256,
        connection: Object.freeze({
            host: '127.0.0.1' as const,
            port: integer(required(env, 'DELETION_REPLAY_DB_PORT'), 'database port', 65535),
            database, user, password: required(env, 'DELETION_REPLAY_DB_PASSWORD'),
        }),
        settings: Object.freeze({
            mode, database, expectedCurrentUser, expectedServerUuid, expectedIdentityEpoch, sourceServerUuid,
            maxIntents: integer(env.DELETION_REPLAY_MAX_INTENTS ?? '1000', 'maximum intent count', 10000),
            maxDurationMs: integer(env.DELETION_REPLAY_MAX_DURATION_MS ?? '60000', 'time budget', 300000),
        }),
    });
}
