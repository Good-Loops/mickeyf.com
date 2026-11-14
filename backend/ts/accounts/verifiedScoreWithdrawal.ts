import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from './deletionJournal';
import { verifyDeletedAccountEffects } from './verifiedDeletionEffects';

/** The caller owns the transaction, reviewed schema and writer fence. */
export async function verifyScoreWithdrawal(connection: Pick<PoolConnection, 'query'>, accountId: string): Promise<boolean> {
    if (!isAccountId(accountId)) return false;
    const query = async (sql: string) => (await connection.query<RowDataPacket[]>({ sql, timeout: 10_000 }, [accountId]))[0];
    const account = await query('SELECT account_uuid FROM users WHERE account_uuid=? LIMIT 2 FOR UPDATE');
    if (!Array.isArray(account) || account.length > 1) throw new Error('Account identity unavailable.');
    if (!account.length) return verifyDeletedAccountEffects(connection, [accountId]);
    const permission = await query(`SELECT visibility,policy_digest,registration_policy_version,country_code,age_band,authorizer_uuid
        FROM account_score_permissions WHERE account_uuid=? LIMIT 2 FOR UPDATE`);
    if (!Array.isArray(permission) || permission.length !== 1 || permission[0].visibility !== 'private'
        || ['policy_digest', 'registration_policy_version', 'country_code', 'age_band', 'authorizer_uuid']
            .some(field => permission[0][field] !== null)) return false;
    const forms = await query(`SELECT reference FROM parent_signed_forms
        WHERE child_uuid=? AND public_approved=1 AND public_withdrawn=0 LIMIT 1 FOR UPDATE`);
    const grants = await query(`SELECT state_hash FROM parent_registration_attempts WHERE child_uuid=?
        AND purpose='publish-scores' AND phase<>'used' AND (phase<>'cancelled' OR grant_hash IS NOT NULL) LIMIT 1 FOR UPDATE`);
    if (!Array.isArray(forms) || !Array.isArray(grants)) throw new Error('Withdrawal effects unavailable.');
    return forms.length === 0 && grants.length === 0;
}
