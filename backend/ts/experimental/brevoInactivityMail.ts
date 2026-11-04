import { NONRESPONSE_NOTICE, NONRESPONSE_NOTICE_DIGEST } from './childInactivityNonresponsePolicy';

const API = 'https://api.brevo.com/v3';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/u;
const MESSAGE_ID = /^<[^\s<>\x00-\x1f\x7f]{1,250}>$/u;
const MAX_BODY_BYTES = 128 * 1024;
const LIMIT = 100;
const FAILURE_EVENTS = new Set(['hardBounce', 'softBounce', 'hard_bounce', 'soft_bounce', 'deferred',
    'blocked', 'invalid', 'invalid_email', 'error', 'spam', 'unsubscribed']);
const OTHER_EVENTS = new Set(['request', 'sent', 'opened', 'uniqueOpened', 'click', 'proxy_open', 'unique_proxy_open']);

export type WarningAttempt = Readonly<{ attemptId: string; recipient: string; sender: string;
    language: 'en' | 'pt-BR'; noticeDigest: string }>;
export type SendResult = Readonly<{ kind: 'accepted'; messageId: string }> | Readonly<{ kind: 'uncertain' }>;
export type WarningBinding = Readonly<{ recipient: string; sender: string; messageId: string; notBeforeMs: number }>;
export type MailObservation = Readonly<{ kind: 'delivered'; observedAt: string }> | Readonly<{ kind: 'hold' }>;
type Fetch = typeof fetch;

function validEmail(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 254 && EMAIL.test(value);
}
function validKey(value: unknown): value is string {
    return typeof value === 'string' && /^[\x21-\x7e]{16,512}$/u.test(value);
}

/** Bounded responses; malformed or oversized replies are never treated as evidence. */
async function readJson(response: Response): Promise<unknown> {
    if (!response.ok || !response.body) throw new Error('Provider response unavailable.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > MAX_BODY_BYTES) throw new Error('Provider response too large.');
            chunks.push(part.value);
        }
        return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')) as unknown;
    } finally { await reader.cancel().catch(() => undefined); }
}

/**
 * Send exactly one already-persisted, approved warning attempt. This adapter is
 * not wired to production. All unknown outcomes require reconciliation; neither
 * this function nor its callers may automatically resend an uncertain attempt.
 */
export async function sendBrevoInactivityWarning(apiKey: string, attempt: WarningAttempt,
    fetcher: Fetch = fetch): Promise<SendResult> {
    if (!validKey(apiKey) || !attempt || !UUID.test(attempt.attemptId) || !validEmail(attempt.recipient)
        || !validEmail(attempt.sender) || attempt.noticeDigest !== NONRESPONSE_NOTICE_DIGEST
        || !['en', 'pt-BR'].includes(attempt.language) || typeof fetcher !== 'function') {
        throw new TypeError('Invalid inactivity warning configuration.');
    }
    const portuguese = attempt.language === 'pt-BR';
    // This per-recipient field requires Brevo's per-contact tracking-consent
    // setting to be enabled; activation must verify that account setting too.
    const payload = { sender: { email: attempt.sender }, to: [{ email: attempt.recipient, contactPixelTrackingConsent: false }],
        replyTo: { email: 'mickeyf.plays@gmail.com' },
        subject: portuguese ? 'Aviso sobre uma conta infantil no Ludolume' : 'Notice about a child account on Ludolume',
        textContent: `${portuguese ? NONRESPONSE_NOTICE.ptBR : NONRESPONSE_NOTICE.en}\n\nhttps://mickeyf.com/parent-accounts`,
        headers: { idempotencyKey: attempt.attemptId } };
    try {
        const response = await fetcher(`${API}/smtp/email`, { method: 'POST', redirect: 'error',
            headers: { 'api-key': apiKey, accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
        const body = await readJson(response);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'uncertain' };
        const messageId = (body as Record<string, unknown>).messageId;
        return typeof messageId === 'string' && MESSAGE_ID.test(messageId)
            ? { kind: 'accepted', messageId } : { kind: 'uncertain' };
    } catch { return { kind: 'uncertain' }; }
}

/**
 * Read current provider observations for the exact persisted binding. This is not
 * a durable receipt, a completeness proof, or authority to delete: later events,
 * restore/replay, Apple relay forwarding, and missed polling still require guards.
 */
export async function observeBrevoInactivityWarning(apiKey: string, binding: WarningBinding, nowMs: number,
    fetcher: Fetch = fetch): Promise<MailObservation> {
    if (!validKey(apiKey) || !binding || !validEmail(binding.recipient) || !validEmail(binding.sender)
        || typeof binding.messageId !== 'string' || !MESSAGE_ID.test(binding.messageId)
        || !Number.isSafeInteger(binding.notBeforeMs) || !Number.isSafeInteger(nowMs)
        || binding.notBeforeMs < 0 || nowMs < binding.notBeforeMs || typeof fetcher !== 'function') {
        throw new TypeError('Invalid inactivity warning binding.');
    }
    // A provider query covers at most 90 days. Older attempts require independently
    // persisted evidence and reconciliation; an empty report is never proof.
    if (nowMs - binding.notBeforeMs > 89 * 86_400_000) return { kind: 'hold' };
    const url = new URL(`${API}/smtp/statistics/events`);
    url.searchParams.set('messageId', binding.messageId);
    url.searchParams.set('days', '90');
    url.searchParams.set('limit', String(LIMIT));
    try {
        const response = await fetcher(url.toString(), { method: 'GET', redirect: 'error',
            headers: { 'api-key': apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
        const body = await readJson(response);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'hold' };
        const events = (body as Record<string, unknown>).events;
        if (!Array.isArray(events) || events.length === 0 || events.length >= LIMIT) return { kind: 'hold' };
        let deliveredAt: number | null = null;
        for (const value of events) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'hold' };
            const event = value as Record<string, unknown>;
            if (event.messageId !== binding.messageId || event.email !== binding.recipient || event.from !== binding.sender
                || typeof event.event !== 'string' || typeof event.date !== 'string'
                || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(event.date)) return { kind: 'hold' };
            const eventMs = Date.parse(event.date);
            const fraction = /\.(\d{1,3})Z$/u.exec(event.date)?.[1] ?? '';
            // The event API can omit fractional seconds. Round forward by one
            // unit of its stated precision rather than starting a timer early.
            const conservativeMs = eventMs + 10 ** (3 - fraction.length);
            if (!Number.isSafeInteger(eventMs) || eventMs < binding.notBeforeMs || eventMs > nowMs
                || !Number.isSafeInteger(conservativeMs) || conservativeMs > nowMs
                || new Date(eventMs).toISOString() !== event.date.replace(/(?:\.(\d{1,3}))?Z$/u,
                    (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`)) return { kind: 'hold' };
            if (FAILURE_EVENTS.has(event.event)) return { kind: 'hold' };
            if (event.event === 'delivered') deliveredAt = Math.max(deliveredAt ?? 0, conservativeMs);
            else if (!OTHER_EVENTS.has(event.event)) return { kind: 'hold' };
        }
        const domain = binding.recipient.slice(binding.recipient.lastIndexOf('@') + 1).toLowerCase();
        // A relay accepting a message does not establish forwarding to the
        // actual parent. icloud.com can be either a relay or a normal inbox.
        if (['privaterelay.appleid.com', 'private.icloud.com', 'icloud.com'].includes(domain)) return { kind: 'hold' };
        return deliveredAt === null ? { kind: 'hold' } : { kind: 'delivered', observedAt: new Date(deliveredAt).toISOString() };
    } catch { return { kind: 'hold' }; }
}
