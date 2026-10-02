import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import { mayPublishScores, type ScoreParticipationPolicy } from '../config/scoreParticipationPolicy';

const timeout = 10_000;
const rows = async (connection: PoolConnection, sql: string, values: unknown[]) =>
    (await connection.query<RowDataPacket[]>({ sql, timeout }, values))[0];

export async function scoreParticipationTarget(connection: PoolConnection, context: ProviderAuthContext, accountId: string) {
    await rows(connection, 'SELECT account_uuid FROM users WHERE account_uuid=? LIMIT 1 FOR UPDATE', [accountId]);
    const targets = await rows(connection, `SELECT u.user_id, u.account_uuid, p.country_code, p.age_band, p.policy_version,
        c.parent_uuid FROM users u LEFT JOIN account_registration_profiles p ON p.account_uuid=u.account_uuid
        LEFT JOIN parent_child_consents c ON c.child_uuid=u.account_uuid WHERE u.account_uuid=? LIMIT 1`, [accountId]);
    const target = targets[0];
    if (!target || (accountId !== context.account!.accountId && target.parent_uuid !== context.account!.accountId)) {
        throw new Error('Score account unavailable.');
    }
    return target;
}

export function canAuthorizePublication(target: RowDataPacket, actorId: string, policy?: ScoreParticipationPolicy): boolean {
    const isSelf = target.account_uuid === actorId;
    if (isSelf && target.parent_uuid !== null) return false;
    return mayPublishScores(policy, target.country_code ? { country: target.country_code, ageBand: target.age_band,
        registrationVersion: target.policy_version } : null, isSelf ? 'self' : 'parent');
}

export function scoreProfileDigest(target: RowDataPacket): Buffer {
    return createHash('sha256').update(JSON.stringify([target.account_uuid, target.country_code,
        target.age_band, target.policy_version, target.parent_uuid])).digest();
}

export async function approveScoreParticipation(connection: PoolConnection, context: ProviderAuthContext,
    accountId: string, policy: ScoreParticipationPolicy, expectedProfile: Buffer): Promise<void> {
    const target = await scoreParticipationTarget(connection, context, accountId);
    if (!Buffer.isBuffer(expectedProfile) || !scoreProfileDigest(target).equals(expectedProfile)
        || !canAuthorizePublication(target, context.account!.accountId, policy)) throw new Error('Publication policy is closed for this account.');
    await connection.query({ sql: `INSERT INTO account_score_permissions
        (account_uuid, visibility, policy_digest, registration_policy_version, country_code, age_band, authorizer_uuid, confirmed_at)
        VALUES (?, 'public', ?, ?, ?, ?, ?, UTC_TIMESTAMP(6)) AS choice
        ON DUPLICATE KEY UPDATE visibility=choice.visibility, policy_digest=choice.policy_digest,
        registration_policy_version=choice.registration_policy_version, country_code=choice.country_code,
        age_band=choice.age_band, authorizer_uuid=choice.authorizer_uuid, confirmed_at=choice.confirmed_at`, timeout },
    [accountId, policy.digest, target.policy_version, target.country_code, target.age_band, context.account!.accountId]);
}

/** Also used during approved recovery; never erases private scores or the account. */
export async function removePublicScoreParticipation(connection: PoolConnection, accountId: string): Promise<void> {
    await connection.query({ sql: `INSERT INTO account_score_permissions
        (account_uuid, visibility, confirmed_at) VALUES (?, 'private', UTC_TIMESTAMP(6))
        ON DUPLICATE KEY UPDATE visibility='private', policy_digest=NULL, registration_policy_version=NULL,
        country_code=NULL, age_band=NULL, authorizer_uuid=NULL, confirmed_at=UTC_TIMESTAMP(6)`, timeout }, [accountId]);
    await connection.query({ sql: `UPDATE parent_registration_attempts SET phase='cancelled', grant_hash=NULL
        WHERE child_uuid=? AND purpose='publish-scores' AND phase <> 'used'`, timeout }, [accountId]);
}

/** Projection is deliberately limited to the caller's decision, not family identity/profile fields. */
export async function readScoreParticipation(connection: PoolConnection, context: ProviderAuthContext,
    accountId: string, policy?: ScoreParticipationPolicy) {
    const target = await scoreParticipationTarget(connection, context, accountId);
    const [permission] = await rows(connection, 'SELECT visibility, policy_digest, registration_policy_version, country_code, age_band, authorizer_uuid FROM account_score_permissions WHERE account_uuid=?', [accountId]);
    const publicChoice = permission?.visibility === 'public' && policy?.digest.equals(permission.policy_digest)
        && permission.registration_policy_version === target.policy_version && permission.country_code === target.country_code
        && permission.age_band === target.age_band && permission.authorizer_uuid === (target.parent_uuid ?? target.account_uuid);
    const historical = !permission && (!target.country_code || (await rows(connection,
        "SELECT account_uuid FROM account_registration_profiles WHERE account_uuid=? AND score_visibility='public'", [accountId])).length === 1);
    return { visibility: publicChoice || historical ? 'public' as const : 'private' as const,
        canPublish: canAuthorizePublication(target, context.account!.accountId, policy) };
}
