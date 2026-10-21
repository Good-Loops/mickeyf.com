type Environment = Readonly<Record<string, string | undefined>>;

export const LOCAL_PROVIDER_SERVER_UUID = 'd1e6865c-ecad-11ee-a6b0-42010a400002';
export const LOCAL_PROVIDER_DATABASE_ACCOUNT = 'cms_mickeyf@%';
export const LOCAL_PROVIDER_SECRET_VERSIONS = Object.freeze({
    signing: 'projects/1012884798546/secrets/ludolume-apple-signin-private-key/versions/1',
    encryption: 'projects/1012884798546/secrets/ludolume-apple-token-encryption-keys/versions/1',
});

export type LocalProviderRuntime = Readonly<{
    expectedServerUuid: string;
    expectedAccount: string;
    maintenanceEnabled: boolean;
}>;

/** Local real-account development remains explicit; it never impersonates a Cloud Run workload. */
export function loadLocalProviderRuntime(env: Environment = process.env): LocalProviderRuntime | undefined {
    const enabled = env.LUDOLUME_LOCAL_PROVIDER_RUNTIME;
    if (enabled === undefined || enabled === 'false') return undefined;
    const maintenance = env.LUDOLUME_LOCAL_PROVIDER_MAINTENANCE_ENABLED;
    if (enabled !== 'true' || env.NODE_ENV !== 'development' || env.K_SERVICE !== undefined
        || (env.LUDOLUME_ISOLATED_RUNTIME !== undefined && env.LUDOLUME_ISOLATED_RUNTIME !== 'false')
        || !['127.0.0.1', 'localhost'].includes(env.DB_HOST ?? '')
        || env.DB_PORT !== '3306' || env.DB_NAME !== 'cms' || env.DB_USER !== 'cms_mickeyf'
        || env.LUDOLUME_LOCAL_PROVIDER_EXPECTED_SERVER_UUID !== LOCAL_PROVIDER_SERVER_UUID
        || env.GOOGLE_APPLICATION_CREDENTIALS !== undefined
        || env.APPLE_SIGN_IN_PRIVATE_KEY !== undefined || env.APPLE_TOKEN_ENCRYPTION_KEYS !== undefined
        || (maintenance !== undefined && maintenance !== 'false' && maintenance !== 'true')) {
        throw new Error('Local provider development requires its explicit loopback database and credential profile.');
    }
    if ((env.APPLE_TOKEN_RUNTIME_SECRETS_ENABLED === 'true' || maintenance === 'true')
        && (maintenance !== 'true' || env.APPLE_MAINTENANCE_HTTP_ENABLED !== 'true'
            || env.APPLE_MAINTENANCE_EXPECTED_SERVER_UUID !== LOCAL_PROVIDER_SERVER_UUID)) {
        throw new Error('Local Apple issuance requires verified local maintenance to remain available.');
    }
    return Object.freeze({ expectedServerUuid: LOCAL_PROVIDER_SERVER_UUID,
        expectedAccount: LOCAL_PROVIDER_DATABASE_ACCOUNT, maintenanceEnabled: maintenance === 'true' });
}

/** A local credential grant is limited to the two reviewed versions, never an arbitrary project secret. */
export function assertLocalProviderSecretVersions(signing: string, encryption: string): void {
    const normalized = (value: string) => value.replace('projects/noted-reef-387021/', 'projects/1012884798546/');
    if (normalized(signing) !== LOCAL_PROVIDER_SECRET_VERSIONS.signing
        || normalized(encryption) !== LOCAL_PROVIDER_SECRET_VERSIONS.encryption) {
        throw new Error('Local provider development requires the reviewed Apple credential versions.');
    }
}
