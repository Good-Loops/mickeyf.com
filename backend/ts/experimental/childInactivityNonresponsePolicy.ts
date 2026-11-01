import { createHash } from 'node:crypto';
import { isAccountId } from '../accounts/deletionJournal';
import { parseInactivityInstant, type InactivitySnapshot } from '../accounts/childInactivityPolicy';

/** Local policy candidate only: it is not connected to the deletion workflow. */
export const NONRESPONSE_NOTICE = Object.freeze({
    version: 'child-inactivity-nonresponse-candidate-1',
    en: "This child's account has been inactive online for almost three years or longer. If it remains inactive, we may delete it no earlier than four years after the last online activity and 12 months after the 30-day warning period ends, even if you do not reply. Sign in to the child's account or use the parent keep-account control to restart the timer. Offline play may not update the timer.",
    ptBR: 'Esta conta infantil está sem atividade on-line há quase três anos ou mais. Se continuar inativa, poderemos excluí-la após pelo menos quatro anos da última atividade on-line e 12 meses depois do fim do prazo de aviso de 30 dias, mesmo que você não responda. Entre na conta da criança ou use o controle do responsável para manter a conta e reiniciar o prazo. O uso off-line pode não atualizar o prazo.',
});
export const NONRESPONSE_NOTICE_DIGEST = createHash('sha256').update(JSON.stringify(NONRESPONSE_NOTICE)).digest('hex');

const DAY = 86_400_000;
const digest = /^[a-f0-9]{64}$/u;
export type AcceptedOutreach = Readonly<{
    parentId: string; childId: string; activityAt: string; targetDigest: string;
    warningId: string; noticeDigest: string; channel: 'email'; acceptedAt: string;
    /** Opaque digest only; actual provider evidence must be checked by the caller. */
    acceptanceDigest: string;
}>;
export type NonresponseDecision = 'hold' | 'warning-due' | 'waiting' | 'candidate';

function addCalendarYears(instant: number, years: number): number {
    const date = new Date(instant);
    // February 29 rolls forward to March 1, so a deadline never moves earlier.
    date.setUTCFullYear(date.getUTCFullYear() + years);
    return date.getTime();
}

/**
 * A provider acceptance is evidence of a send attempt, not a read receipt.
 * `verifyOutreach` must independently authenticate the provider receipt and
 * the exact current verified recipient and notice; no such adapter is wired.
 * A candidate is not permission to delete: activity continuity and restore
 * safety must be checked again under the deletion transaction's locks.
 */
export function assessNonresponseCandidate(snapshot: InactivitySnapshot, outreach: AcceptedOutreach | null,
    acknowledgement: 'not-acknowledged' | 'acknowledged' | 'unknown', now: number,
    verifyOutreach: (outreach: AcceptedOutreach) => boolean): NonresponseDecision {
    if (!snapshot || !isAccountId(snapshot.parentId) || !isAccountId(snapshot.childId)
        || snapshot.parentId === snapshot.childId || snapshot.activityComplete !== true
        || snapshot.channel !== 'email' || snapshot.targetVerified !== true
        || typeof snapshot.currentTargetDigest !== 'string' || !digest.test(snapshot.currentTargetDigest)
        || acknowledgement !== 'not-acknowledged' || snapshot.warning !== null
        || !Number.isSafeInteger(now) || now < 0 || typeof verifyOutreach !== 'function') return 'hold';
    const activity = parseInactivityInstant(snapshot.activityAt);
    if (activity === null || activity > now) return 'hold';
    const thirdAnniversary = addCalendarYears(activity, 3);
    const warningStart = thirdAnniversary - 30 * DAY;
    // Add the extension to the already rounded third anniversary. For a
    // February 29 start, adding four years in one step would be a day early.
    const inactivityDeadline = addCalendarYears(thirdAnniversary, 1);
    if (!Number.isSafeInteger(warningStart) || !Number.isSafeInteger(inactivityDeadline) || now < warningStart) return 'hold';
    if (!outreach) return 'warning-due';
    const acceptedAt = parseInactivityInstant(outreach.acceptedAt);
    if (outreach.parentId !== snapshot.parentId || outreach.childId !== snapshot.childId
        || outreach.activityAt !== snapshot.activityAt || outreach.targetDigest !== snapshot.currentTargetDigest
        || outreach.channel !== 'email' || !isAccountId(outreach.warningId)
        || outreach.noticeDigest !== NONRESPONSE_NOTICE_DIGEST
        || typeof outreach.acceptanceDigest !== 'string' || !digest.test(outreach.acceptanceDigest)
        // The instant parser rounds up for deletion deadlines. For the earliest
        // allowed warning, compare its actual millisecond floor instead.
        || acceptedAt === null || Date.parse(outreach.acceptedAt) < warningStart || acceptedAt > now) return 'hold';
    // Interpret the owner's additional 12 months as starting after the later
    // of the three-year anniversary and the original 30-day warning period.
    const outreachDeadline = addCalendarYears(Math.max(thirdAnniversary, acceptedAt + 30 * DAY), 1);
    if (!Number.isSafeInteger(outreachDeadline)) return 'hold';
    try { if (verifyOutreach(Object.freeze({ ...outreach })) !== true) return 'hold'; }
    catch { return 'hold'; }
    return now >= inactivityDeadline && now >= outreachDeadline ? 'candidate' : 'waiting';
}
