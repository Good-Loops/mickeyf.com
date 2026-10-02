import bcrypt from 'bcryptjs';
import type { ScoreParticipationPolicy } from '../config/scoreParticipationPolicy';
import { scoreParticipationTarget, scoreProfileDigest, canAuthorizePublication, approveScoreParticipation, readScoreParticipation, removePublicScoreParticipation } from './scoreParticipationRepository';
import { familySelectionDigest } from './familyDeletionSelection';
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import type { VerifiedProviderIdentity } from '../auth/providerIdentity';
import { readLiveSession } from '../auth/accountSessionRepository';
import { withUserSubmissionLock, type UserSubmissionLockContext } from '../leaderboards/userSubmissionLock';
import { AccountDeletionPendingError, deleteOwnedAccountRows } from './accountDeletionRepository';
import type { AccountDeletionJournal } from './deletionJournal';
import type { ParentChallenge, ParentChild, ParentRegistrationStore } from './parentRegistrationFlow';

const timeout = 10_000;
type Database = Pick<Pool, 'query' | 'getConnection'>;
const command = (connection: Pick<PoolConnection, 'query'>, sql: string, values: unknown[] = []) => connection.query({ sql, timeout }, values);
const rows = async (connection: Pick<PoolConnection, 'query'>, sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>({ sql, timeout }, values))[0];
const utc = (timestamp: number) => new Date(timestamp).toISOString().replace('T', ' ').replace('Z', '');

export async function cleanupParentRegistrationAttempts(database: Pick<Pool, 'query'>): Promise<{ backlog: boolean }> {
    for (let batch = 0; batch < 10; batch++) {
        const [result] = await database.query<ResultSetHeader>({ sql: 'DELETE FROM parent_registration_attempts WHERE expires_at <= UTC_TIMESTAMP(6) LIMIT 100', timeout });
        if (!Number.isInteger(result.affectedRows) || result.affectedRows < 0 || result.affectedRows > 100) throw new Error('Parent cleanup result unavailable.');
        if (result.affectedRows < 100) return { backlog: false };
    }
    return { backlog: (await rows(database, 'SELECT state_hash FROM parent_registration_attempts WHERE expires_at <= UTC_TIMESTAMP(6) LIMIT 1')).length !== 0 };
}

export class ManagedChildrenError extends Error {
    constructor() { super('Withdraw consent and delete managed child accounts before deleting the parent account.'); }
}
/** Must run under the parent's existing submission/account lock, BEFORE independently journaling its deletion. */
export async function assertNoManagedChildren(connection: PoolConnection, accountId: string): Promise<void> {
    if ((await rows(connection, 'SELECT child_uuid FROM parent_child_consents WHERE parent_uuid = ? LIMIT 1', [accountId])).length) {
        throw new ManagedChildrenError();
    }
}

async function transaction<T>(lock: UserSubmissionLockContext, operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
    let phase: 'begin' | 'active' | 'commit' = 'begin';
    try {
        await command(lock.connection, 'START TRANSACTION'); phase = 'active';
        const value = await operation(lock.connection);
        phase = 'commit'; await command(lock.connection, 'COMMIT'); return value;
    } catch (error) {
        if (phase !== 'active') lock.invalidateConnection();
        else { try { await command(lock.connection, 'ROLLBACK'); } catch { lock.invalidateConnection(); } }
        throw error;
    }
}

/** Only short-lived proof metadata and the minimal current consent relationship are persisted. */
export function createParentRegistrationRepository(database: Database, journal: AccountDeletionJournal, publicationPolicy?: ScoreParticipationPolicy): ParentRegistrationStore {
    if (!journal || typeof journal.recordAccountDeletion !== 'function') throw new TypeError('Parent registration requires deletion journaling.');
    async function currentParent(connection: PoolConnection, context: ProviderAuthContext, creation = false) {
        const parent = context.account; const session = context.session;
        if (!parent || !session || parent.accountId !== session.accountId) throw new Error('Invalid parent context.');
        const accounts = await rows(connection, 'SELECT account_uuid FROM users WHERE user_id = ? AND account_uuid = ? LIMIT 1 FOR UPDATE',
            [parent.userId, parent.accountId]);
        if (accounts.length !== 1 || !await readLiveSession(connection, parent.userId, parent.accountId, session.sessionId)) {
            throw new Error('Parent session is no longer live.');
        }
        if (creation) {
            const profiles = await rows(connection, 'SELECT age_band FROM account_registration_profiles WHERE account_uuid = ? LIMIT 1', [parent.accountId]);
            if (profiles.some(profile => profile.age_band !== 'adult')) throw new Error('An adult parent account is required.');
            const children = await rows(connection, 'SELECT child_uuid FROM parent_child_consents WHERE parent_uuid = ? LIMIT 50', [parent.accountId]);
            if (children.length >= 50) throw new Error('Parent account limit reached.');
        }
        return parent;
    }
    const locked = <T>(context: ProviderAuthContext, operation: (connection: PoolConnection) => Promise<T>) => {
        if (!context.account) throw new Error('Parent account required.');
        return withUserSubmissionLock(database, context.account.userId, lock => transaction(lock, operation));
    };
    async function targetLocked<T>(context: ProviderAuthContext, targetId: string,
        operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
        return withUserSubmissionLock(database, context.account!.userId, async lock => {
            const target = (await rows(lock.connection, 'SELECT user_id FROM users WHERE account_uuid=? LIMIT 1', [targetId]))[0];
            if (!target) throw new Error('Score account unavailable.');
            return target.user_id === context.account!.userId ? transaction(lock, operation)
                : lock.withAdditionalLock(target.user_id, childLock => transaction(childLock, operation));
        });
    }
    async function linked(connection: Pick<PoolConnection, 'query'>, context: ProviderAuthContext, identity: Pick<VerifiedProviderIdentity, 'provider' | 'subject'>) {
        const links = await rows(connection, 'SELECT account_uuid FROM account_provider_identities WHERE provider = ? AND subject = ? AND account_uuid = ? LIMIT 1',
            [identity.provider, Buffer.from(identity.subject, 'ascii'), context.account!.accountId]);
        return links.length === 1;
    }
    function challenge(row: RowDataPacket): ParentChallenge {
        return { stateHash: row.state_hash, bindingHash: row.binding_hash, parentAccountId: row.parent_uuid,
            parentUserId: row.parent_user_id, clientKey: row.client_key, nonce: row.nonce, policyDigest: row.policy_digest,
            expiresAt: Number(row.expiresAt), operation: row.purpose === 'create-child'
                ? { purpose: 'create-child', country: row.country_code } : row.purpose === 'delete-family'
                    ? { purpose: 'delete-family', familyDigest: row.family_digest }
                    : { purpose: row.purpose === 'publish-scores' ? 'publish-scores' : 'withdraw-child', childAccountId: row.child_uuid } };
    }
    async function grant(connection: PoolConnection, grantHash: Buffer, context: ProviderAuthContext, digest: Buffer, purpose: string) {
        await currentParent(connection, context, purpose === 'create-child');
        const found = await rows(connection, `SELECT state_hash, parent_uuid, purpose, country_code, child_uuid, family_digest, profile_digest, consent_version, policy_version, provider, subject
            FROM parent_registration_attempts WHERE grant_hash = ? AND binding_hash = ? AND parent_uuid = ?
            AND policy_digest = ? AND purpose = ? AND phase = 'approved' AND expires_at > UTC_TIMESTAMP(6) LIMIT 1 FOR UPDATE`,
        [grantHash, context.bindingHash, context.account!.accountId, digest, purpose]);
        const row = found[0];
        if (!row || !Buffer.isBuffer(row.subject) || !await linked(connection, context, { provider: row.provider, subject: row.subject.toString('ascii') })) {
            throw new Error('Parent grant is unavailable.');
        }
        return row;
    }
    async function consume(connection: PoolConnection, stateHash: Buffer, context: ProviderAuthContext) {
        await currentParent(connection, context);
        const [result] = await connection.query<ResultSetHeader>({ sql: `UPDATE parent_registration_attempts SET phase = 'used'
            WHERE state_hash = ? AND phase = 'approved' AND expires_at > UTC_TIMESTAMP(6)`, timeout }, [stateHash]);
        if (result.affectedRows !== 1) throw new Error('Parent grant expired.');
    }
    return {
        async begin(attempt, context) {
            // Expiry rejects independently; opportunistic bounded cleanup stores no identity after expiry.
            await command(database, 'DELETE FROM parent_registration_attempts WHERE expires_at <= UTC_TIMESTAMP(6) LIMIT 100');
            return locked(context, async connection => {
                await currentParent(connection, context, attempt.operation.purpose === 'create-child');
                let profileDigest: Buffer | null = null;
                if (attempt.operation.purpose === 'publish-scores') {
                    const target = await scoreParticipationTarget(connection, context, attempt.operation.childAccountId);
                    if (!journal.recordPublicScoreWithdrawal || !canAuthorizePublication(target, context.account!.accountId, publicationPolicy)) throw new Error('Publication policy is closed.');
                    profileDigest = scoreProfileDigest(target);
                }
                if (attempt.operation.purpose === 'delete-family') {
                    const ids = (await rows(connection, 'SELECT child_uuid FROM parent_child_consents WHERE parent_uuid = ? ORDER BY child_uuid LIMIT 51', [context.account!.accountId])).map(row => row.child_uuid);
                    const digest = familySelectionDigest(ids);
                    if (!digest?.equals(attempt.operation.familyDigest)) throw new Error('Family confirmation is stale.');
                }
                if (attempt.operation.purpose === 'withdraw-child') {
                    const own = await rows(connection, 'SELECT child_uuid FROM parent_child_consents WHERE parent_uuid = ? AND child_uuid = ? LIMIT 1',
                        [context.account!.accountId, attempt.operation.childAccountId]);
                    if (own.length !== 1) throw new Error('Child account unavailable.');
                }
                await command(connection, `INSERT INTO parent_registration_attempts
                    (state_hash, binding_hash, parent_uuid, parent_user_id, client_key, nonce, policy_digest, purpose,
                    country_code, child_uuid, family_digest, profile_digest, expires_at, phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, LEAST(?, UTC_TIMESTAMP(6) + INTERVAL 5 MINUTE), 'pending')`,
                [attempt.stateHash, attempt.bindingHash, attempt.parentAccountId, attempt.parentUserId, attempt.clientKey, attempt.nonce,
                    attempt.policyDigest, attempt.operation.purpose, attempt.operation.purpose === 'create-child' ? attempt.operation.country : null,
                    ['withdraw-child', 'publish-scores'].includes(attempt.operation.purpose) && 'childAccountId' in attempt.operation ? attempt.operation.childAccountId : null,
                    attempt.operation.purpose === 'delete-family' ? attempt.operation.familyDigest : null, profileDigest, utc(attempt.expiresAt)]);
                return true;
            });
        },
        consumeChallenge: (stateHash, context) => locked(context, async connection => {
            await currentParent(connection, context);
            const found = await rows(connection, `SELECT state_hash, binding_hash, parent_uuid, parent_user_id, client_key, nonce, policy_digest,
                purpose, country_code, child_uuid, family_digest, ROUND(TIMESTAMPDIFF(MICROSECOND, '1970-01-01', expires_at) / 1000) AS expiresAt FROM parent_registration_attempts
                WHERE state_hash = ? AND binding_hash = ? AND parent_uuid = ? AND phase = 'pending' AND expires_at > UTC_TIMESTAMP(6) LIMIT 1 FOR UPDATE`,
            [stateHash, context.bindingHash, context.account!.accountId]);
            if (found.length !== 1) return null;
            await command(connection, "UPDATE parent_registration_attempts SET phase = 'verifying' WHERE state_hash = ?", [stateHash]);
            return challenge(found[0]);
        }),
        isLinkedParent: (context, identity) => locked(context, async connection => {
            await currentParent(connection, context); return linked(connection, context, identity);
        }),
        approve: (approval, context) => locked(context, async connection => {
            await currentParent(connection, context);
            if (!await linked(connection, context, approval.identity)) return false;
            const [result] = await connection.query<ResultSetHeader>({ sql: `UPDATE parent_registration_attempts
                SET phase = 'approved', grant_hash = ?, provider = ?, subject = ?, consent_version = ?, policy_version = ?
                WHERE state_hash = ? AND binding_hash = ? AND parent_uuid = ? AND policy_digest = ?
                AND phase = 'verifying' AND expires_at > UTC_TIMESTAMP(6)`, timeout },
            [approval.grantHash, approval.identity.provider, Buffer.from(approval.identity.subject, 'ascii'), approval.consentVersion, approval.policyVersion,
                approval.stateHash, context.bindingHash, context.account!.accountId, approval.policyDigest]);
            return result.affectedRows === 1;
        }),
        cancel: (stateHash, context) => locked(context, async connection => {
            await currentParent(connection, context);
            await command(connection, `UPDATE parent_registration_attempts SET phase = 'cancelled', grant_hash = NULL, provider = NULL, subject = NULL
                WHERE state_hash = ? AND binding_hash = ? AND parent_uuid = ? AND phase <> 'used'`,
            [stateHash, context.bindingHash, context.account!.accountId]);
        }),
        async createChild(grantHash, context, policyDigest, credentials) {
            // Hash outside locks. Transactional grant validation still precedes any insertion.
            const passwordHash = await bcrypt.hash(credentials.password, 12);
            return locked(context, async connection => {
                const approval = await grant(connection, grantHash, context, policyDigest, 'create-child');
                const [insert] = await connection.query<ResultSetHeader>({ sql: 'INSERT INTO users (user_name, email, user_password) VALUES (?, NULL, ?)', timeout },
                    [credentials.userName, passwordHash]);
                const [child] = await rows(connection, 'SELECT account_uuid FROM users WHERE user_id = ?', [insert.insertId]);
                await command(connection, `INSERT INTO account_registration_profiles
                    (account_uuid, country_code, age_band, policy_version, score_visibility) VALUES (?, ?, 'minor', ?, 'private')`,
                [child.account_uuid, approval.country_code, approval.policy_version]);
                await command(connection, `INSERT INTO parent_child_consents (child_uuid, parent_uuid, country_code, policy_digest, consent_version, consented_at)
                    VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
                [child.account_uuid, context.account!.accountId, approval.country_code, policyDigest, approval.consent_version]);
                await consume(connection, approval.state_hash, context);
                return { accountId: child.account_uuid, userName: credentials.userName, scoreVisibility: 'private' as const };
            });
        },
        async withdrawChild(grantHash, context, digest) {
            let recorded = false;
            try {
                // Lock the parent before the child. Managed child/minor accounts cannot create children, preventing cycles.
                await withUserSubmissionLock(database, context.account!.userId, async parentLock => {
                    const target = await rows(parentLock.connection, `SELECT u.user_id, u.account_uuid FROM parent_registration_attempts a
                        INNER JOIN parent_child_consents c ON c.child_uuid = a.child_uuid AND c.parent_uuid = a.parent_uuid
                        INNER JOIN users u ON u.account_uuid = c.child_uuid WHERE a.grant_hash = ? AND a.binding_hash = ? AND a.parent_uuid = ?
                        AND a.purpose = 'withdraw-child' AND a.phase = 'approved' AND a.expires_at > UTC_TIMESTAMP(6) LIMIT 1`,
                    [grantHash, context.bindingHash, context.account!.accountId]);
                    if (target.length !== 1 || target[0].user_id === context.account!.userId) throw new Error('Child account unavailable.');
                    await parentLock.withAdditionalLock(target[0].user_id, childLock => transaction(childLock, async connection => {
                        const approval = await grant(connection, grantHash, context, digest, 'withdraw-child');
                        const own = await rows(connection, 'SELECT user_id, account_uuid FROM users WHERE account_uuid = ? LIMIT 1 FOR UPDATE', [approval.child_uuid]);
                        const relation = await rows(connection, 'SELECT child_uuid FROM parent_child_consents WHERE parent_uuid = ? AND child_uuid = ? LIMIT 1',
                            [context.account!.accountId, approval.child_uuid]);
                        if (own.length !== 1 || relation.length !== 1 || own[0].user_id !== target[0].user_id) throw new Error('Child account unavailable.');
                        await consume(connection, approval.state_hash, context);
                        await journal.recordAccountDeletion(own[0].account_uuid); recorded = true;
                        await deleteOwnedAccountRows(connection, own[0].user_id, own[0].account_uuid, new Date().toISOString());
                    }));
                });
            } catch (error) { if (recorded) throw new AccountDeletionPendingError(error); throw error; }
        },
        async publishScores(grantHash, context, digest) {
            if (!publicationPolicy || !journal.recordPublicScoreWithdrawal || !digest.equals(publicationPolicy.digest)) throw new Error('Publication closed.');
            const target = (await rows(database, `SELECT child_uuid FROM parent_registration_attempts WHERE grant_hash=?
                AND binding_hash=? AND parent_uuid=? AND purpose='publish-scores' AND phase='approved' LIMIT 1`,
                [grantHash, context.bindingHash, context.account!.accountId]))[0];
            if (!target) throw new Error('Publication grant unavailable.');
            await targetLocked(context, target.child_uuid, async connection => {
                const approval = await grant(connection, grantHash, context, digest, 'publish-scores');
                await approveScoreParticipation(connection, context, approval.child_uuid, publicationPolicy, approval.profile_digest);
                await consume(connection, approval.state_hash, context);
            });
        },
        withdrawScores: (context, targetId) => targetLocked(context, targetId, async connection => {
            await currentParent(connection, context);
            if (!journal.recordPublicScoreWithdrawal) throw new Error('Withdrawal journal unavailable.');
            await scoreParticipationTarget(connection, context, targetId);
            await journal.recordPublicScoreWithdrawal(targetId);
            await removePublicScoreParticipation(connection, targetId);
        }),
        scoreStatus: (context, targetId) => locked(context, async connection => {
            await currentParent(connection, context);
            return readScoreParticipation(connection, context, targetId, publicationPolicy);
        }),
        async deleteFamily(grantHash, context, digest, confirmedFamily) {
            let recorded = false;
            try {
                await withUserSubmissionLock(database, context.account!.userId, async parentLock => {
                    const targets = await rows(parentLock.connection, `SELECT u.user_id, u.account_uuid FROM parent_child_consents c
                        INNER JOIN users u ON u.account_uuid = c.child_uuid WHERE c.parent_uuid = ? ORDER BY u.user_id LIMIT 51`, [context.account!.accountId]);
                    const selected = familySelectionDigest(targets.map(row => row.account_uuid));
                    if (!selected?.equals(confirmedFamily) || targets.some(row => row.user_id === context.account!.userId)) throw new Error('Family confirmation is stale.');
                    const lockChildren = (index: number): Promise<void> => index < targets.length
                        ? parentLock.withAdditionalLock(targets[index].user_id, () => lockChildren(index + 1))
                        : transaction(parentLock, async connection => {
                            const approval = await grant(connection, grantHash, context, digest, 'delete-family');
                            if (!Buffer.isBuffer(approval.family_digest) || !approval.family_digest.equals(confirmedFamily)) throw new Error('Family grant mismatch.');
                            const current = await rows(connection, `SELECT u.user_id, u.account_uuid FROM parent_child_consents c
                                INNER JOIN users u ON u.account_uuid = c.child_uuid WHERE c.parent_uuid = ? ORDER BY u.user_id LIMIT 51`, [context.account!.accountId]);
                            if (!familySelectionDigest(current.map(row => row.account_uuid))?.equals(confirmedFamily)
                                || current.some((row, index) => row.user_id !== targets[index]?.user_id)) throw new Error('Family changed.');
                            for (const target of current) await rows(connection, 'SELECT account_uuid FROM users WHERE user_id=? AND account_uuid=? FOR UPDATE', [target.user_id, target.account_uuid]);
                            await consume(connection, approval.state_hash, context);
                            // Child intents first: recovery must never see a parent-only intent for a retained family.
                            for (const target of [...current, { account_uuid: context.account!.accountId }]) {
                                recorded = true;
                                await journal.recordAccountDeletion(target.account_uuid);
                            }
                            for (const target of current) await deleteOwnedAccountRows(connection, target.user_id, target.account_uuid);
                            await deleteOwnedAccountRows(connection, context.account!.userId, context.account!.accountId);
                        });
                    await lockChildren(0);
                });
            } catch (error) { if (recorded) throw new AccountDeletionPendingError(error); throw error; }
        },
        listChildren: context => locked(context, async connection => {
            await currentParent(connection, context);
            const children = await rows(connection, `SELECT u.account_uuid, u.user_name FROM parent_child_consents c
                INNER JOIN users u ON u.account_uuid = c.child_uuid WHERE c.parent_uuid = ? ORDER BY u.user_id LIMIT 50`, [context.account!.accountId]);
            return children.map(child => ({ accountId: child.account_uuid, userName: child.user_name, scoreVisibility: 'private' })) as ParentChild[];
        }),
    };
}
