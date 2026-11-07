import type { Pool, RowDataPacket } from 'mysql2/promise';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const pageSize = 50;

/** Read-only, owner-private discovery. Presence does not mean that a message was sent or consent was approved. */
export function relayForwardingStatusSql(enabled: boolean): string {
    if (typeof enabled !== 'boolean') throw new TypeError('Invalid relay-state configuration.');
    if (!enabled) return "'unknown'";
    return `CASE WHEN EXISTS (SELECT 1 FROM parent_form_apple_relay_state r
        WHERE r.reference=f.reference AND r.forwarding_disabled=1) THEN 'last-event-disabled'
        WHEN EXISTS (SELECT 1 FROM parent_form_apple_relay_state r
        WHERE r.reference=f.reference AND r.forwarding_disabled=0) THEN 'last-event-enabled' ELSE 'unknown' END`;
}

export async function pendingParentFormOutreach(database: Pick<Pool, 'query'>, after: string | null,
    relayStateEnabled = false) {
    if (after !== null && (typeof after !== 'string' || !uuid.test(after))) throw new TypeError('Invalid pending-request cursor.');
    const [rows] = await database.query<RowDataPacket[]>({ sql: `SELECT f.reference, f.verified_contact, f.country_code, f.provider,
        HEX(f.policy_digest) AS policy_digest, f.policy_version, f.consent_version,
        DATE_FORMAT(f.submitted_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS submitted_at,
        DATE_FORMAT(f.expires_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS expires_at,
        ${relayForwardingStatusSql(relayStateEnabled)} AS relay_forwarding_status,
        EXISTS (SELECT 1 FROM account_provider_identities i WHERE i.account_uuid=f.parent_uuid
            AND i.provider=f.provider AND i.subject=f.subject) AS provider_linked
        FROM parent_signed_forms f WHERE f.status='pending' AND f.expires_at>UTC_TIMESTAMP(6)
        AND (? IS NULL OR f.reference>?) ORDER BY f.reference LIMIT 51`, timeout: 10_000 }, [after, after]);
    if (!Array.isArray(rows) || rows.length > pageSize + 1) throw new Error('Pending requests are unavailable.');
    let previous = after ?? '';
    const requests = rows.map(row => {
        if (!row || typeof row !== 'object' || typeof row.reference !== 'string' || !uuid.test(row.reference)
            || row.reference <= previous || typeof row.verified_contact !== 'string'
            || row.verified_contact.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(row.verified_contact)
            || /[\u0000-\u001f\u007f]/u.test(row.verified_contact)
            || !['US', 'BR'].includes(row.country_code) || !['google', 'apple'].includes(row.provider)
            || ![0, 1].includes(row.provider_linked)
            || !['unknown', 'last-event-enabled', 'last-event-disabled'].includes(row.relay_forwarding_status)
            || typeof row.policy_digest !== 'string' || !/^[0-9a-f]{64}$/iu.test(row.policy_digest)
            || typeof row.policy_version !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/u.test(row.policy_version)
            || typeof row.consent_version !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/u.test(row.consent_version)
            || typeof row.submitted_at !== 'string' || !timestamp.test(row.submitted_at)
            || typeof row.expires_at !== 'string' || !timestamp.test(row.expires_at)
            || !Number.isFinite(Date.parse(row.submitted_at)) || !Number.isFinite(Date.parse(row.expires_at))
            || row.expires_at <= row.submitted_at) throw new Error('Pending requests are unavailable.');
        previous = row.reference;
        return { reference: row.reference, verifiedContact: row.provider_linked === 1 && row.relay_forwarding_status !== 'last-event-disabled'
            ? row.verified_contact : null,
            providerLinked: row.provider_linked === 1, deliveryStatus: 'unknown' as const,
            relayForwardingStatus: row.relay_forwarding_status as 'unknown' | 'last-event-enabled' | 'last-event-disabled', country: row.country_code,
            provider: row.provider, policyDigest: row.policy_digest.toUpperCase(), policyVersion: row.policy_version,
            consentVersion: row.consent_version, submittedAt: row.submitted_at, expiresAt: row.expires_at };
    });
    const hasMore = requests.length > pageSize;
    const page = requests.slice(0, pageSize);
    return { requests: page, nextAfter: hasMore ? page[page.length - 1].reference : null };
}

/** Provider linkage is not evidence that a recorded contact can still receive mail. */
export function redactUnavailableFormContact<T extends { provider_linked: unknown; verified_contact: unknown; relay_forwarding_status: unknown }>(
    form: T,
): Omit<T, 'verified_contact'> & { verified_contact: unknown; delivery_status: 'unknown' } {
    if (!form || ![0, 1].includes(form.provider_linked as number)
        || !['unknown', 'last-event-enabled', 'last-event-disabled'].includes(form.relay_forwarding_status as string)) throw new Error('Request is unavailable.');
    if (form.provider_linked === 1 && (typeof form.verified_contact !== 'string' || !form.verified_contact)) {
        throw new Error('Request is unavailable.');
    }
    return { ...form, verified_contact: form.provider_linked === 1 && form.relay_forwarding_status !== 'last-event-disabled'
        ? form.verified_contact : null, delivery_status: 'unknown' };
}
