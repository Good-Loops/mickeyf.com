import { assertDatabaseConfirmation, assertMutationAuthorized, type MigrationConfig } from './migrationConfig';

type Environment = Readonly<Record<string, string | undefined>>;
export type AccountIdentityConfirmation = Readonly<{
    approvedPlanSha256?: string;
    confirmedServerUuid?: string;
}>;

export function assertAccountIdentityCommandConfirmed(
    command: 'plan' | 'apply' | 'verify',
    config: Pick<MigrationConfig, 'host' | 'port' | 'database'>,
    env: Environment = process.env
): AccountIdentityConfirmation {
    assertDatabaseConfirmation(config, env.MIGRATION_CONFIRM_DATABASE);
    if (env.MIGRATION_CONFIRM_TARGET !== `${config.host}:${config.port}/${config.database}`) {
        throw new Error('MIGRATION_CONFIRM_TARGET must exactly match MIGRATION_DB_HOST:PORT/NAME');
    }
    if (command !== 'apply') return Object.freeze({});
    assertMutationAuthorized(config, env);
    if (env.MIGRATION_ALLOW_ACCOUNT_IDENTITY !== '1') {
        throw new Error('MIGRATION_ALLOW_ACCOUNT_IDENTITY=1 is required');
    }
    if (env.MIGRATION_CONFIRM_WRITERS_DRAINED !== '1') {
        throw new Error('MIGRATION_CONFIRM_WRITERS_DRAINED=1 is required; disable and drain database writers first');
    }
    const approvedPlanSha256 = env.MIGRATION_CONFIRM_ACCOUNT_IDENTITY_PLAN_SHA256;
    if (!approvedPlanSha256 || !/^[a-f0-9]{64}$/u.test(approvedPlanSha256)) {
        throw new Error('MIGRATION_CONFIRM_ACCOUNT_IDENTITY_PLAN_SHA256 must be the exact lowercase plan digest');
    }
    const confirmedServerUuid = env.MIGRATION_CONFIRM_SERVER_UUID;
    if (!confirmedServerUuid || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(confirmedServerUuid)) {
        throw new Error('MIGRATION_CONFIRM_SERVER_UUID must be the exact lowercase server UUID from the plan');
    }
    return Object.freeze({ approvedPlanSha256, confirmedServerUuid });
}
