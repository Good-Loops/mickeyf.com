type Environment = Readonly<Record<string, string | undefined>>;

export const APPLE_MAINTENANCE_AUDIENCE = 'https://mickeyf-org-j7yuum4tiq-uc.a.run.app';
export const APPLE_MAINTENANCE_PATH = '/internal/maintenance/apple';
export const APPLE_MAINTENANCE_URL = `${APPLE_MAINTENANCE_AUDIENCE}${APPLE_MAINTENANCE_PATH}`;
export const APPLE_MAINTENANCE_CALLER_EMAIL =
    'mickeyf-receipt-cleanup@noted-reef-387021.iam.gserviceaccount.com';

export type AppleMaintenanceConfig = Readonly<{
    audience: string;
    callerEmail: string;
    callerSubject: string;
    expectedServerUuid: string;
}>;

/** This is an independent maintenance switch, not permission to enable Apple login. */
export function loadAppleMaintenanceConfig(env: Environment = process.env): AppleMaintenanceConfig | undefined {
    if (env.APPLE_MAINTENANCE_HTTP_ENABLED !== 'true') return undefined;
    const callerSubject = env.APPLE_MAINTENANCE_CALLER_SUBJECT;
    const expectedServerUuid = env.APPLE_MAINTENANCE_EXPECTED_SERVER_UUID;
    if (env.NODE_ENV !== 'production'
        || (env.LUDOLUME_ISOLATED_RUNTIME !== undefined && env.LUDOLUME_ISOLATED_RUNTIME !== 'false')
        || !callerSubject || !/^[1-9][0-9]{5,29}$/u.test(callerSubject)
        || !expectedServerUuid || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(expectedServerUuid)) {
        throw new Error('Apple maintenance requires explicit production identity and database configuration.');
    }
    return Object.freeze({ audience: APPLE_MAINTENANCE_AUDIENCE,
        callerEmail: APPLE_MAINTENANCE_CALLER_EMAIL, callerSubject, expectedServerUuid });
}
