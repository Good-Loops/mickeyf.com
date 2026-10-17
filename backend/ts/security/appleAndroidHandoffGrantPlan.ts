import { PRODUCTION_RUNTIME_DATABASE_ACCOUNT } from './runtimeGrantManifest';

/** Additive proposal only; existing grant profiles and their fingerprints remain unchanged. */
export function renderAppleAndroidHandoffGrantPlan(): readonly string[] {
    const account = PRODUCTION_RUNTIME_DATABASE_ACCOUNT;
    const target = `'${account.user}'@'${account.host}'`;
    const table = '`cms`.`apple_android_handoffs`';
    return Object.freeze([
        `GRANT SELECT (state_hash, binding_hash, nonce, client_key, action, account_uuid, user_id, phase, encrypted_credential, created_at, expires_at) ON ${table} TO ${target};`,
        `GRANT INSERT (state_hash, binding_hash, nonce, client_key, action, account_uuid, user_id, phase, created_at, expires_at) ON ${table} TO ${target};`,
        `GRANT UPDATE (phase, encrypted_credential) ON ${table} TO ${target};`,
        `GRANT DELETE ON ${table} TO ${target};`,
    ]);
}
