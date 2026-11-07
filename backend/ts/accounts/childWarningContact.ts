import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from './deletionJournal';
import { parseInactivityInstant } from './childInactivityPolicy';
import type { WarningContext } from './durableChildWarningStore';

/**
 * Used forms retain the provider-verified contact. Runtime grants cannot change
 * that contact/identity; request cleanup excludes used forms. Read it under the
 * same parent/child locks as the independently verified activity and warning.
 * There is no fallback to an unverified users.email or an unmatched form.
 */
export async function resolveChildWarningContact(connection: PoolConnection, parentId: string, childId: string): Promise<WarningContext> {
    const held: WarningContext = { recipient: null, snapshot: { parentId, childId, activityAt: null,
        activityComplete: false, targetVerified: false, currentTargetDigest: null, channel: 'email', warning: null } };
    if (!isAccountId(parentId) || !isAccountId(childId) || parentId === childId) return held;
    const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT f.reference, f.provider, f.subject, f.verified_contact AS recipient,
            DATE_FORMAT(a.retention_activity_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS activityAt
        FROM parent_child_consents c
        JOIN parent_managed_child_activity a ON a.child_uuid=c.child_uuid
        JOIN parent_signed_forms f ON f.child_uuid=c.child_uuid AND f.parent_uuid=c.parent_uuid
            AND f.country_code=c.country_code AND f.policy_digest=c.policy_digest AND f.consent_version=c.consent_version
        JOIN account_provider_identities p ON p.account_uuid=c.parent_uuid AND p.provider=f.provider AND p.subject=f.subject
        WHERE c.parent_uuid=? AND c.child_uuid=? AND c.country_code IN ('BR','US') AND f.status='used'
        LIMIT 2 FOR SHARE`, timeout: 10_000 }, [parentId, childId]);
    if (rows.length !== 1) return held;
    const row = rows[0];
    if (!isAccountId(row.reference) || !['google', 'apple'].includes(row.provider)
        || !Buffer.isBuffer(row.subject) || row.subject.length < 1 || row.subject.length > 255
        || typeof row.recipient !== 'string' || row.recipient.length > 254
        || !/^[^\s@\x00-\x1f\x7f]+@[^\s@]+\.[^\s@]+$/u.test(row.recipient)
        || parseInactivityInstant(row.activityAt) === null) return held;
    const domain = row.recipient.slice(row.recipient.lastIndexOf('@') + 1).toLowerCase();
    // Relay forwarding has a separate acceptance test; do not send and only
    // discover afterward that its receipt is unusable for the waiting period.
    if (['privaterelay.appleid.com', 'private.icloud.com', 'icloud.com'].includes(domain)) return held;
    const revision = createHash('sha256').update(JSON.stringify([row.reference, row.provider, row.subject.toString('hex')])).digest('hex');
    return { recipient: row.recipient, snapshot: { parentId, childId, activityAt: row.activityAt,
        activityComplete: true, targetVerified: true, currentTargetDigest: revision, channel: 'email', warning: null } };
}
