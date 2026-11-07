import { createHash } from 'node:crypto';
import { isAccountId } from '../accounts/deletionJournal';
import { parseInactivityInstant, type InactivitySnapshot } from '../accounts/childInactivityPolicy';

/** Automatic nonresponse policy; production activation is separately gated. */
export const NONRESPONSE_NOTICE = Object.freeze({
    version: 'child-inactivity-nonresponse-2026-11-04.2',
    en: "This child's account has been inactive online for at least three years. If it remains inactive, we may delete it after a further 12 months from delivery of this warning. Sign in to the child's account or use Keep account on the parent account page to restart the timer. Offline play may not update the timer. Replying to this email alone does not restart the timer.",
    ptBR: 'Esta conta infantil está sem atividade on-line há pelo menos três anos. Se continuar inativa, poderemos excluí-la após mais 12 meses a partir da entrega deste aviso. Entre na conta da criança ou use Manter conta na página da conta do responsável para reiniciar o prazo. O uso off-line pode não atualizar o prazo. Responder a este e-mail, por si só, não reinicia o prazo.',
});
export const NONRESPONSE_NOTICE_DIGEST = createHash('sha256').update(JSON.stringify(NONRESPONSE_NOTICE)).digest('hex');

const digest = /^[a-f0-9]{64}$/u;
export type AcceptedOutreach = Readonly<{
    parentId: string; childId: string; activityAt: string; targetDigest: string;
    warningId: string; noticeDigest: string; channel: 'email'; acceptedAt: string;
    /** Opaque digests only; the caller must authenticate both provider events. */
    acceptanceDigest: string; deliveredAt: string; deliveryDigest: string;
}>;
export type NonresponseDecision = 'hold' | 'warning-due' | 'waiting' | 'candidate';

function addCalendarYears(instant: number, years: number): number {
    const date = new Date(instant);
    // February 29 rolls forward to March 1, so a deadline never moves earlier.
    date.setUTCFullYear(date.getUTCFullYear() + years);
    return date.getTime();
}

/**
 * Acceptance can precede delivery by days. A provider-reported delivery is
 * also not proof of inbox placement or reading. `verifyDeliveredOutreach` must
 * authenticate both events, their timestamps, the recipient and notice, and
 * reject subsequent recorded failures. The durable warning workflow supplies
 * this verification; production scheduling remains separately gated.
 * A candidate is not permission to delete: activity continuity and restore
 * safety must be checked again under the deletion transaction's locks.
 */
export function assessNonresponseCandidate(snapshot: InactivitySnapshot, outreach: AcceptedOutreach | null,
    acknowledgement: 'not-acknowledged' | 'acknowledged' | 'unknown', now: number,
    verifyDeliveredOutreach: (outreach: AcceptedOutreach) => boolean): NonresponseDecision {
    if (!snapshot || !isAccountId(snapshot.parentId) || !isAccountId(snapshot.childId)
        || snapshot.parentId === snapshot.childId || snapshot.activityComplete !== true
        || snapshot.channel !== 'email' || snapshot.targetVerified !== true
        || typeof snapshot.currentTargetDigest !== 'string' || !digest.test(snapshot.currentTargetDigest)
        || acknowledgement !== 'not-acknowledged' || snapshot.warning !== null
        || !Number.isSafeInteger(now) || now < 0 || typeof verifyDeliveredOutreach !== 'function') return 'hold';
    const activity = parseInactivityInstant(snapshot.activityAt);
    if (activity === null || activity > now) return 'hold';
    const thirdAnniversary = addCalendarYears(activity, 3);
    const warningStart = thirdAnniversary;
    // Add the extension to the already rounded third anniversary. For a
    // February 29 start, adding four years in one step would be a day early.
    const inactivityDeadline = addCalendarYears(thirdAnniversary, 1);
    if (!Number.isSafeInteger(warningStart) || !Number.isSafeInteger(inactivityDeadline) || now < warningStart) return 'hold';
    if (!outreach) return 'warning-due';
    const acceptedAt = parseInactivityInstant(outreach.acceptedAt);
    const deliveredAt = parseInactivityInstant(outreach.deliveredAt);
    if (outreach.parentId !== snapshot.parentId || outreach.childId !== snapshot.childId
        || outreach.activityAt !== snapshot.activityAt || outreach.targetDigest !== snapshot.currentTargetDigest
        || outreach.channel !== 'email' || !isAccountId(outreach.warningId)
        || outreach.noticeDigest !== NONRESPONSE_NOTICE_DIGEST
        || typeof outreach.acceptanceDigest !== 'string' || !digest.test(outreach.acceptanceDigest)
        || typeof outreach.deliveryDigest !== 'string' || !digest.test(outreach.deliveryDigest)
        // The instant parser rounds up for deletion deadlines. For the earliest
        // allowed warning, compare its actual millisecond floor instead.
        || acceptedAt === null || Date.parse(outreach.acceptedAt) < warningStart || acceptedAt > now
        || deliveredAt === null || outreach.deliveredAt < outreach.acceptedAt || deliveredAt > now) return 'hold';
    const outreachDeadline = addCalendarYears(Math.max(thirdAnniversary, deliveredAt), 1);
    if (!Number.isSafeInteger(outreachDeadline)) return 'hold';
    try { if (verifyDeliveredOutreach(Object.freeze({ ...outreach })) !== true) return 'hold'; }
    catch { return 'hold'; }
    return now >= inactivityDeadline && now >= outreachDeadline ? 'candidate' : 'waiting';
}
