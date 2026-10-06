import notice from '../../../shared/privacyNotice.json' with { type: 'json' };
import type { SignedParentFormRequest, ParentConfig } from '@/services/parentRegistrationApi';
import PrivacyNoticeLink from './PrivacyNoticeLink';
import './SignedParentForm.css';

export default function SignedParentForm({ request, policy }: { request: SignedParentFormRequest; policy: Extract<ParentConfig, { enabled: true }> }) {
    return <article className="signed-parent-form" aria-label="Signed parent consent form">
        <h3>Ludolume parent consent form</h3>
        <p>{notice.operatorName}<br />{notice.operatorAddress}<br />{notice.operatorTelephone}<br />{notice.contactEmail}</p>
        <p>{notice.signedParentForm.notice}</p>
        <p><PrivacyNoticeLink url={policy.privacyNoticeUrl} /></p>
        <dl>
            <dt>Request reference</dt><dd>{request.reference}</dd>
            <dt>Parent account</dt><dd>{request.parentAccountId}</dd>
            <dt>Verified parent email</dt><dd>{request.verifiedContact}</dd>
            <dt>Child's chosen nickname and country</dt><dd>{request.userName} · {request.country}</dd>
            <dt>Return and activate before</dt><dd>{request.expiresAt}</dd>
            <dt>Account consent version</dt><dd>{request.consentVersion} · {request.policyVersion}</dd>
        </dl>
        <p>{policy.consentText}</p>
        <p>□ I authorize the private child account described above.</p>
        {request.publicConsentText && <>
            <h4>Separate optional public disclosure</h4>
            <p>{request.publicConsentText}</p>
            <p>□ I separately authorize public leaderboard disclosure. Leave unchecked to keep scores private.</p>
            <p>Public consent version: {request.publicConsentVersion}<br />Public policy reference: {request.publicPolicyDigest}</p>
        </>}
        <p>I am this child's parent or legal guardian, am 18 or older, and am authorized to make the choices marked above.</p>
        <p>Parent / guardian full name: ____________________________________</p>
        <p>Handwritten signature: ________________________________________</p>
        <p>Date: ____________________</p>
        <p>Form version: {notice.signedParentForm.version} · Privacy notice: {notice.version}</p>
        <button className="signed-parent-form__print" type="button" onClick={() => window.print()}>Print signed parent form</button>
    </article>;
}
