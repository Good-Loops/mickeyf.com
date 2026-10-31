import { isAccountId } from './deletionJournal';
import { createHash } from 'node:crypto';

export const INACTIVITY_WARNING_DAYS = 30;
export const INACTIVITY_NOTICE = Object.freeze({
    version: 'child-inactivity-2026-10-31.1',
    en: "This child's account has been inactive online for almost three years or longer. If you acknowledge this warning, the account may be deleted no earlier than three years of inactivity and 30 days after acknowledgment. Sign in to the child's account or use the parent keep-account control to restart the timer. Offline play may not update the timer.",
    ptBR: 'Esta conta infantil está sem atividade on-line há quase três anos ou mais. Se você confirmar este aviso, a conta poderá ser excluída após pelo menos três anos de inatividade e 30 dias após a confirmação. Entre na conta da criança ou use o controle do responsável para manter a conta e reiniciar o prazo. O uso off-line pode não atualizar o prazo.',
});
export const INACTIVITY_NOTICE_DIGEST = createHash('sha256').update(JSON.stringify(INACTIVITY_NOTICE)).digest('hex');
const DAY = 24 * 60 * 60 * 1000;
const digest = /^[a-f0-9]{64}$/u;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;

/** Exact UTC microsecond strings are compared before millisecond date arithmetic. */
function instant(value: unknown): number | null {
    if (typeof value !== 'string' || !timestamp.test(value)) return null;
    const milliseconds = Date.parse(value);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return null;
    if (new Date(milliseconds).toISOString() !== `${value.slice(0, 23)}Z`) return null;
    // Dates from SQL have microsecond precision. Round up, never down: a
    // decision made in the same millisecond must not become eligible early.
    return milliseconds + (value.slice(23, 26) === '000' ? 0 : 1);
}

/** February 29 rolls forward to March 1 rather than deleting early. */
function thirdAnniversary(milliseconds: number): number {
    const date = new Date(milliseconds);
    date.setUTCFullYear(date.getUTCFullYear() + 3);
    return date.getTime();
}

export type InactivityWarning = Readonly<{
    parentId: string; childId: string; activityAt: string; targetDigest: string; channel: InactivityChannel;
    warningId: string; noticeDigest: string; deliveredAt: string; receiptDigest: string;
}>;

export type InactivityChannel = 'in-app' | 'email';

export type InactivitySnapshot = Readonly<{
    parentId: string; childId: string;
    /** Missing activity or a known tracking failure must never be treated as inactivity. */
    activityAt: string | null; activityComplete: boolean;
    /** Channel-specific HMAC target binding, never a raw email address. */
    currentTargetDigest: string | null; targetVerified: boolean; channel: InactivityChannel;
    warning: InactivityWarning | null;
}>;

export type InactivityDecision = 'hold' | 'warning-due' | 'await-confirmed-warning' | 'grace' | 'eligible';

/** Pure, fail-closed policy; no assertion here is evidence of an actual delivery. */
export function assessChildInactivity(snapshot: InactivitySnapshot, nowMs: number): InactivityDecision {
    if (!snapshot || !isAccountId(snapshot.parentId) || !isAccountId(snapshot.childId)
        || snapshot.parentId === snapshot.childId || snapshot.activityComplete !== true
        || !['in-app', 'email'].includes(snapshot.channel)
        || snapshot.targetVerified !== true || typeof snapshot.currentTargetDigest !== 'string'
        || !digest.test(snapshot.currentTargetDigest) || !Number.isSafeInteger(nowMs) || nowMs < 0) return 'hold';
    const activity = instant(snapshot.activityAt);
    if (activity === null || activity > nowMs) return 'hold';
    const anniversary = thirdAnniversary(activity);
    if (!Number.isSafeInteger(anniversary) || nowMs < anniversary - INACTIVITY_WARNING_DAYS * DAY) return 'hold';
    if (!snapshot.warning) return 'warning-due';
    const warning = snapshot.warning;
    const delivered = instant(warning.deliveredAt);
    if (warning.parentId !== snapshot.parentId || warning.childId !== snapshot.childId
        || warning.activityAt !== snapshot.activityAt || warning.channel !== snapshot.channel || warning.targetDigest !== snapshot.currentTargetDigest
        || !isAccountId(warning.warningId) || warning.noticeDigest !== INACTIVITY_NOTICE_DIGEST
        || typeof warning.receiptDigest !== 'string' || !digest.test(warning.receiptDigest)
        || delivered === null || delivered < anniversary - INACTIVITY_WARNING_DAYS * DAY || delivered > nowMs) {
        return 'await-confirmed-warning';
    }
    return nowMs >= anniversary && nowMs >= delivered + INACTIVITY_WARNING_DAYS * DAY ? 'eligible' : 'grace';
}
