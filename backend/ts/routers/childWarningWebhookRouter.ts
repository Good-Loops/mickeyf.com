import { createHash, timingSafeEqual } from 'node:crypto';
import { json, Router } from 'express';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from '../accounts/deletionJournal';
import type { createChildWarningNonresponse } from '../accounts/childWarningNonresponse';

export const CHILD_WARNING_WEBHOOK_PATH = '/maintenance/child-warnings/brevo';
const failures = new Set(['soft_bounce', 'hard_bounce', 'blocked', 'error', 'invalid_email', 'spam', 'unsubscribed', 'deferred']);

/** Only authenticated delivery failures cross this boundary; engagement events never affect activity. */
export function createChildWarningWebhookRouter(database: Pick<Pool, 'query'>,
    workflow: Pick<ReturnType<typeof createChildWarningNonresponse>, 'recordFailure'>, token: string): Router {
    if (!/^[A-Za-z0-9_-]{43,128}$/u.test(token)) throw new TypeError('A private webhook token is required.');
    const expected = createHash('sha256').update(`Bearer ${token}`).digest();
    const router = Router();
    router.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        const provided = req.get('Authorization') ?? '';
        if (!timingSafeEqual(expected, createHash('sha256').update(provided).digest())) return res.status(401).end();
        next();
    });
    router.post('/', json({ limit: '8kb', strict: true }), async (req, res) => {
        const event = req.body;
        if (!event || Array.isArray(event) || typeof event !== 'object' || typeof event.event !== 'string') return res.status(400).end();
        if (!failures.has(event.event)) return res.status(204).end();
        const recipient = event.email, id = event['message-id'];
        if (typeof recipient !== 'string' || recipient.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(recipient)
            || typeof id !== 'string' || !/^(?:<[^\s<>\x00-\x1f\x7f]{1,250}>|[^\s<>\x00-\x1f\x7f]{1,250})$/u.test(id)) return res.status(400).end();
        const messageId = id.startsWith('<') ? id : `<${id}>`;
        const tags = event.tags ?? (typeof event.tag === 'string' ? [event.tag] : []);
        const attempts = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string' && tag.startsWith('ludolume-warning:')) : [];
        if (attempts.length > 1 || (attempts[0] && !isAccountId(attempts[0].slice(17)))) return res.status(400).end();
        const attemptId = attempts[0]?.slice(17) ?? null;
        try {
            const [rows] = await database.query<RowDataPacket[]>({ sql: `SELECT child_uuid AS childId,
                JSON_UNQUOTE(JSON_EXTRACT(state_json,'$.parentId')) AS parentId FROM parent_child_warning_history
                WHERE JSON_CONTAINS(JSON_EXTRACT(state_json,'$.events'),JSON_OBJECT('kind','accepted','messageId',?))
                OR (? IS NOT NULL AND JSON_CONTAINS(JSON_EXTRACT(state_json,'$.events'),JSON_OBJECT('kind','dispatch','attemptId',?))) LIMIT 2`,
            timeout: 10_000 }, [messageId, attemptId, attemptId]);
            if (rows.length > 1 || rows.some(row => !isAccountId(row.parentId) || !isAccountId(row.childId))) throw new Error('Warning binding unavailable.');
            if (rows[0]) await workflow.recordFailure(rows[0].parentId, rows[0].childId, { messageId, recipient });
            return res.status(204).end();
        } catch {
            // Brevo retries 429; its documented 5xx policy discards the event.
            // Do not return success until the durable hold has committed.
            res.setHeader('Retry-After', '60'); return res.status(429).end();
        }
    });
    return router;
}
