import type { Pool, RowDataPacket } from 'mysql2/promise';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const pageSize = 50;

/** Read-only, owner-private discovery. Presence does not mean that a message was sent or consent was approved. */
export async function pendingParentFormOutreach(database: Pick<Pool, 'query'>, after: string | null) {
    if (after !== null && (typeof after !== 'string' || !uuid.test(after))) throw new TypeError('Invalid pending-request cursor.');
    const [rows] = await database.query<RowDataPacket[]>({ sql: `SELECT f.reference, f.verified_contact, f.country_code, f.provider,
        DATE_FORMAT(f.submitted_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS submitted_at,
        DATE_FORMAT(f.expires_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS expires_at,
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
            || typeof row.submitted_at !== 'string' || !timestamp.test(row.submitted_at)
            || typeof row.expires_at !== 'string' || !timestamp.test(row.expires_at)
            || !Number.isFinite(Date.parse(row.submitted_at)) || !Number.isFinite(Date.parse(row.expires_at))
            || row.expires_at <= row.submitted_at) throw new Error('Pending requests are unavailable.');
        previous = row.reference;
        return { reference: row.reference, verifiedContact: row.provider_linked === 1 ? row.verified_contact : null,
            providerLinked: row.provider_linked === 1, country: row.country_code,
            provider: row.provider, submittedAt: row.submitted_at, expiresAt: row.expires_at };
    });
    const hasMore = requests.length > pageSize;
    const page = requests.slice(0, pageSize);
    return { requests: page, nextAfter: hasMore ? page[page.length - 1].reference : null };
}
