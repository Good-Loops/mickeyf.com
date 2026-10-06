import { createHash } from 'node:crypto';
const notice = require('../../../shared/privacyNotice.json') as {
    version: string; operatorName: string; contactEmail: string; operatorAddress: string; operatorTelephone: string;
    signedParentForm: { version: string; requestLifetimeDays: number; notice: string };
};

export const SIGNED_FORM_VERSION = notice.signedParentForm.version;
export const SIGNED_FORM_LIFETIME_DAYS = notice.signedParentForm.requestLifetimeDays;
export const signedFormRequired = (country: string) => country === 'US';
export const signedFormNoticeDigest = () => createHash('sha256').update(JSON.stringify([
    notice.version, notice.operatorName, notice.contactEmail, notice.operatorAddress, notice.operatorTelephone,
    notice.signedParentForm,
])).digest();
export type SignedParentFormRequest = Readonly<{
    reference: string; parentAccountId: string; country: string; userName: string; verifiedContact: string;
    policyVersion: string; consentVersion: string; status: 'pending' | 'approved' | 'rejected';
    expiresAt: string; publicPolicyDigest: string | null; publicConsentText: string | null; publicConsentVersion: string | null;
}>;
export class SignedParentFormRequiredError extends Error {
    constructor() { super('An approved signed parent form is required.'); }
}
