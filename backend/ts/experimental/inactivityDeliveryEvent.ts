import { createHmac, timingSafeEqual } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const messageId = /^[A-Za-z0-9_-]{1,128}$/u;
const address = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/u;
const bodyLimit = 64 * 1024;
const skewSeconds = 300;

export type ExpectedDelivery = Readonly<{
    providerEmailId: string;
    recipient: string;
    from: string;
    /** Earliest valid creation time of the original, locally persisted send attempt. */
    notBeforeMs: number;
}>;
export type DeliveryObservation = Readonly<{ eventId: string; providerEmailId: string; observedAt: string;
    kind: 'delivered' | 'hold'; reason: 'delivered' | 'bounced' | 'failed' | 'suppressed' | 'delivery_delayed' | 'complained';
    /** Domain hint only; all email providers can forward or filter mail. */
    recipientRoute: 'other' | 'apple-relay' | 'icloud-ambiguous' }>;
export type DeliveryHeaders = Readonly<{ id: unknown; timestamp: unknown; signature: unknown }>;

/** Authenticate raw bytes, including the provider's webhook timestamp and message ID. */
export function verifyDeliverySignature(rawBody: Buffer, headers: DeliveryHeaders, secret: string, nowMs: number): boolean {
    if (!Buffer.isBuffer(rawBody) || rawBody.length < 1 || rawBody.length > bodyLimit
        || !headers || typeof headers.id !== 'string' || !messageId.test(headers.id)
        || typeof headers.timestamp !== 'string' || !/^[1-9][0-9]{0,10}$/u.test(headers.timestamp)
        || typeof headers.signature !== 'string' || headers.signature.length > 4096
        || typeof secret !== 'string' || secret.length > 512 || !/^whsec_[A-Za-z0-9+/]+={0,2}$/u.test(secret)
        || !Number.isSafeInteger(nowMs) || nowMs < 0) return false;
    const encodedKey = secret.slice(6);
    const key = Buffer.from(encodedKey, 'base64');
    if (key.length < 16 || key.toString('base64').replace(/=+$/u, '') !== encodedKey.replace(/=+$/u, '')) return false;
    const timestamp = Number(headers.timestamp);
    if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(nowMs / 1000) - timestamp) > skewSeconds) return false;
    const signed = createHmac('sha256', key).update(`${headers.id}.${headers.timestamp}.`).update(rawBody).digest();
    return headers.signature.split(' ').some(candidate => {
        const match = /^v1,([A-Za-z0-9+/]{43}=)$/u.exec(candidate);
        if (!match) return false;
        const value = Buffer.from(match[1], 'base64');
        return value.length === signed.length && timingSafeEqual(value, signed);
    });
}

/** Preserve subsecond precision and round forward to the SQL microsecond boundary. */
function parseProviderInstant(value: unknown): { canonical: string; ceilingMs: number; floorMs: number } | null {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
    if (!match) return null;
    const local = Date.parse(`${match[1]}Z`);
    if (!Number.isFinite(local) || new Date(local).toISOString().slice(0, 19) !== match[1]
        || (match[3] !== 'Z' && (Number(match[4]) > 14 || Number(match[5]) > 59
            || (Number(match[4]) === 14 && Number(match[5]) !== 0)))) return null;
    const parsed = Date.parse(value);
    if (!Number.isSafeInteger(parsed)) return null;
    const nanos = (match[2] ?? '').padEnd(9, '0');
    let micros = Number(nanos.slice(0, 6)) + (Number(nanos.slice(6)) > 0 ? 1 : 0);
    let secondsMs = Math.floor(parsed / 1000) * 1000;
    if (micros === 1_000_000) { secondsMs += 1000; micros = 0; }
    const floorMs = secondsMs + Math.floor(micros / 1000);
    const ceilingMs = floorMs + (micros % 1000 ? 1 : 0);
    if (!Number.isSafeInteger(floorMs) || !Number.isSafeInteger(ceilingMs)) return null;
    return { canonical: `${new Date(secondsMs).toISOString().slice(0, 19)}.${String(micros).padStart(6, '0')}Z`, floorMs, ceilingMs };
}

/**
 * Verifies a raw Resend/Svix webhook for a previously persisted send attempt.
 * Only a delivered observation means the recipient server accepted the message;
 * a hold observation identifies a potentially invalidating provider event. Neither
 * is a read receipt, forwarding guarantee, or authorization to delete.
 * The caller must durably deduplicate eventId and independently account for later
 * bounces, complaints, contact changes, provider loss, and database restores.
 */
export function verifyInactivityDeliveryEvent(rawBody: Buffer, headers: DeliveryHeaders, secret: string,
    expected: ExpectedDelivery, nowMs: number): DeliveryObservation | null {
    if (!expected || !uuid.test(expected.providerEmailId)
        || typeof expected.recipient !== 'string' || expected.recipient.length > 254 || !address.test(expected.recipient)
        || typeof expected.from !== 'string' || expected.from.length < 3 || expected.from.length > 254
        || /[\r\n\0]/u.test(expected.from) || !Number.isSafeInteger(expected.notBeforeMs)
        || !Number.isSafeInteger(nowMs) || expected.notBeforeMs < 0 || nowMs < expected.notBeforeMs
        || !verifyDeliverySignature(rawBody, headers, secret, nowMs)) return null;
    try {
        const event: unknown = JSON.parse(rawBody.toString('utf8'));
        if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
        const record = event as Record<string, unknown>;
        const kinds: Record<string, DeliveryObservation['reason']> = { 'email.delivered': 'delivered',
            'email.bounced': 'bounced', 'email.failed': 'failed', 'email.suppressed': 'suppressed',
            'email.delivery_delayed': 'delivery_delayed', 'email.complained': 'complained' };
        if (typeof record.type !== 'string' || !Object.prototype.hasOwnProperty.call(kinds, record.type)
            || !record.data || typeof record.data !== 'object' || Array.isArray(record.data)) return null;
        const reason = kinds[record.type];
        const data = record.data as Record<string, unknown>;
        const observed = parseProviderInstant(record.created_at);
        if (!observed || observed.floorMs < expected.notBeforeMs || observed.ceilingMs > nowMs
            || data.email_id !== expected.providerEmailId || data.from !== expected.from
            || !Array.isArray(data.to) || data.to.length !== 1 || data.to[0] !== expected.recipient) return null;
        const recipientDomain = expected.recipient.slice(expected.recipient.lastIndexOf('@') + 1).toLowerCase();
        const recipientRoute = ['privaterelay.appleid.com', 'private.icloud.com'].includes(recipientDomain) ? 'apple-relay'
            : recipientDomain === 'icloud.com' ? 'icloud-ambiguous' : 'other';
        return { eventId: headers.id as string, providerEmailId: expected.providerEmailId, observedAt: observed.canonical,
            kind: reason === 'delivered' ? 'delivered' : 'hold', reason, recipientRoute };
    } catch { return null; }
}
