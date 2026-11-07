import type { Pool, ResultSetHeader } from 'mysql2/promise';
import type { VerifiedAppleNotification } from '../auth/appleNotificationVerifier';

const recordSql = `INSERT INTO parent_form_apple_relay_state
        (reference, last_event_at, forwarding_disabled)
        SELECT f.reference, ?, ? FROM parent_signed_forms f
        WHERE f.provider='apple' AND f.subject=? AND BINARY f.verified_contact=BINARY ?
            AND f.status IN ('pending','approved') AND f.expires_at>UTC_TIMESTAMP(6)
            AND f.submitted_at<TIMESTAMPADD(SECOND, ?, '1970-01-01 00:00:00')
        ON DUPLICATE KEY UPDATE
            forwarding_disabled=CASE
                WHEN VALUES(last_event_at)>last_event_at THEN VALUES(forwarding_disabled)
                WHEN VALUES(last_event_at)=last_event_at THEN GREATEST(forwarding_disabled,VALUES(forwarding_disabled))
                ELSE forwarding_disabled END,
            last_event_at=GREATEST(last_event_at,VALUES(last_event_at))`;
const cleanupSql = `DELETE FROM parent_form_apple_relay_state
        WHERE reference IN (SELECT reference FROM parent_signed_forms
            WHERE status IN ('used','rejected') OR expires_at<=UTC_TIMESTAMP(6)) LIMIT 100`;

/** EXPLAIN checks the actual principal's access without recording an event or deleting data. */
export async function verifyParentFormAppleRelayWriteAccess(database: Pick<Pool, 'query'>): Promise<void> {
    await database.query({ sql: `EXPLAIN ${recordSql}`, timeout: 10_000 },
        [1, 1, Buffer.from('synthetic-readiness-subject'), 'synthetic@example.test', 2]);
    await database.query({ sql: `EXPLAIN ${cleanupSql}`, timeout: 10_000 });
}

/**
 * Persist a verified forwarding change only for matching, unexpired form requests
 * created before the event's second ended. Same-second ordering is ambiguous,
 * so those requests are included conservatively. A missing row means unknown,
 * not enabled. This adapter is not yet enabled in production.
 */
export async function recordParentFormAppleRelayEvent(database: Pick<Pool, 'query'>,
    notification: VerifiedAppleNotification): Promise<void> {
    if (!notification || !['email-enabled', 'email-disabled'].includes(notification.eventType)
        || typeof notification.subject !== 'string' || !/^[\x21-\x7e]{1,255}$/u.test(notification.subject)
        || typeof notification.relayEmail !== 'string' || notification.relayEmail.length > 254
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(notification.relayEmail)
        || notification.relayEmail !== notification.relayEmail.toLowerCase()
        || !Number.isSafeInteger(notification.eventTime) || notification.eventTime < 1
        || !Number.isSafeInteger(notification.eventTime + 1)) {
        throw new TypeError('A complete verified Apple forwarding event is required.');
    }
    const disabled = notification.eventType === 'email-disabled' ? 1 : 0;
    // A same-second conflict is ambiguous. Keep the conservative disabled state.
    // Compare before updating last_event_at: MySQL evaluates assignments in order.
    const [result] = await database.query<ResultSetHeader>({ sql: recordSql, timeout: 10_000 },
    [notification.eventTime, disabled, Buffer.from(notification.subject, 'ascii'), notification.relayEmail,
        notification.eventTime + 1]);
    if (!Number.isSafeInteger(result.affectedRows) || result.affectedRows < 0) throw new Error('Relay state is unavailable.');
}

/** A bounded maintenance pass removes state for completed or expired requests. */
export async function cleanupParentFormAppleRelayState(database: Pick<Pool, 'query'>): Promise<{ backlog: boolean }> {
    const [result] = await database.query<ResultSetHeader>({ sql: cleanupSql, timeout: 10_000 });
    if (!Number.isSafeInteger(result.affectedRows) || result.affectedRows < 0 || result.affectedRows > 100) {
        throw new Error('Relay state cleanup is unavailable.');
    }
    // An exact full batch may have more. A subsequent pass confirms completion.
    return { backlog: result.affectedRows === 100 };
}
