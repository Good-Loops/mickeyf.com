type Environment = Readonly<Record<string, string | undefined>>;

export const ORIGINAL_DATABASE_CONNECTION = 'noted-reef-387021:us-central1:cms-mickeyf';
const ORIGINAL_SERVER_UUID = 'd1e6865c-ecad-11ee-a6b0-42010a400002';
const FAILURE = 'Restored database target is missing, malformed or inconsistent.';

export type RecoveryDatabaseTarget = Readonly<{
    formatVersion: 1;
    connectionName: string;
    serverUuid: string;
}>;

/** Administrative configuration only: this does not attest to completed reconciliation or authorize traffic. */
export function loadRecoveryDatabaseTarget(env: Environment): RecoveryDatabaseTarget | undefined {
    const value = env.LUDOLUME_RESTORED_DATABASE_TARGET;
    if (value === undefined) return undefined;
    try {
        if (env.NODE_ENV !== 'production' || value.length > 1024) throw new Error();
        const target = JSON.parse(value) as RecoveryDatabaseTarget;
        if (!target || Array.isArray(target) || typeof target !== 'object'
            || Object.keys(target).sort().join(',') !== 'connectionName,formatVersion,serverUuid'
            || target.formatVersion !== 1
            || typeof target.connectionName !== 'string'
            || !/^noted-reef-387021:us-central1:[a-z][a-z0-9-]{0,96}[a-z0-9]$/u.test(target.connectionName)
            || target.connectionName === ORIGINAL_DATABASE_CONNECTION
            || typeof target.serverUuid !== 'string'
            || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(target.serverUuid)
            || target.serverUuid === ORIGINAL_SERVER_UUID) throw new Error();
        return Object.freeze({ formatVersion: 1, connectionName: target.connectionName, serverUuid: target.serverUuid });
    } catch { throw new Error(FAILURE); }
}

export function assertRecoveryDatabaseTarget(target: RecoveryDatabaseTarget | undefined,
    connectionName: string | undefined, serverUuid: string | undefined, database: string | undefined): void {
    if (target && (connectionName !== target.connectionName || serverUuid !== target.serverUuid || database !== 'cms')) {
        throw new Error(FAILURE);
    }
}
