import { createHash } from 'node:crypto';
const notice = require('../../../shared/privacyNotice.json') as {
    version: string; operatorName: string; contactEmail: string; operatorAddress: string; operatorTelephone: string;
    signedParentForm: { version: string; requestLifetimeDays: number; notice: string };
    availabilityText: string; sections: unknown; ptBR: unknown;
};

export const SIGNED_FORM_VERSION = notice.signedParentForm.version;
export const SIGNED_FORM_LIFETIME_DAYS = notice.signedParentForm.requestLifetimeDays;
export const signedFormRequired = (country: string, countries: readonly string[] = ['US']) => countries.includes(country);
export const signedFormNoticeDigest = () => createHash('sha256').update(JSON.stringify([
    notice.version, notice.operatorName, notice.contactEmail, notice.operatorAddress, notice.operatorTelephone,
    notice.signedParentForm, notice.availabilityText, notice.sections, notice.ptBR,
])).digest();
// Bind the provider nonce to one form without persisting the form reference on an attempt.
export const signedFormProofNonce = (stateHash: Buffer, reference: string) =>
    createHash('sha256').update('parent-form-proof:').update(stateHash).update(reference).digest('base64url');
export type SignedParentFormRequest = Readonly<{
    reference: string; parentAccountId: string; country: string; userName: string | null; verifiedContact: string;
    policyVersion: string; consentVersion: string; status: 'pending' | 'approved' | 'rejected';
    expiresAt: string; publicPolicyDigest: string | null; publicConsentText: string | null; publicConsentVersion: string | null;
}>;
export class SignedParentFormRequiredError extends Error {
    constructor() { super('An approved signed parent form is required.'); }
}
