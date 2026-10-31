import notice from '../../../shared/privacyNotice.json' with { type: 'json' };
import type { SignedParentFormRequest, ParentConfig } from '@/services/parentRegistrationApi';
import PrivacyNoticeLink from './PrivacyNoticeLink';
import { parsePrivacyNoticeUrl } from '@/config/privacyNoticeUrl';
import './SignedParentForm.css';

export function portugueseParentConsentAvailable(policy: Extract<ParentConfig, { enabled: true }>): boolean {
    return policy.signedFormVersion === notice.signedParentForm.version
        && policy.consentText === notice.consent.parent.text && policy.consentVersion === notice.consent.parent.version;
}

export function portugueseFormAvailable(request: SignedParentFormRequest, policy: Extract<ParentConfig, { enabled: true }>): boolean {
    return portugueseParentConsentAvailable(policy) && request.consentVersion === policy.consentVersion
        && request.policyVersion === policy.policyVersion
        && (request.publicConsentText === null || request.publicConsentText === notice.consent.publicScores.text
            && request.publicConsentVersion === notice.consent.publicScores.version);
}

function PortugueseSignedParentForm({ request, policy }: { request: SignedParentFormRequest; policy: Extract<ParentConfig, { enabled: true }> }) {
    const pt = notice.signedParentForm.ptBR;
    const label = pt.labels;
    const privacyUrl = parsePrivacyNoticeUrl(policy.privacyNoticeUrl);
    if (!portugueseFormAvailable(request, policy) || !privacyUrl) {
        return <p lang="pt-BR" role="alert">{label.unavailable}</p>;
    }
    return <article className="signed-parent-form" lang="pt-BR" aria-label={label.formAria}>
        <h3>{label.title}</h3>
        <p>{notice.operatorName}<br />{notice.operatorAddress}<br />{notice.operatorTelephone}<br />{notice.contactEmail}</p>
        <p>{pt.notice}</p>
        <p><a href={privacyUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{label.privacy}</a></p>
        <dl>
            <dt>{label.reference}</dt><dd>{request.reference}</dd>
            <dt>{label.parentAccount}</dt><dd>{request.parentAccountId}</dd>
            <dt>{label.email}</dt><dd>{request.verifiedContact}</dd>
            {policy.credentialsAfterApproval ? <><dt>{label.country}</dt><dd>{request.country}</dd></>
                : <><dt>{label.nicknameAndCountry}</dt><dd>{request.userName} · {request.country}</dd></>}
            <dt>{label.expires}</dt><dd>{request.expiresAt}</dd>
            <dt>{label.consentVersion}</dt><dd>{request.consentVersion} · {request.policyVersion}</dd>
        </dl>
        <p>{pt.parentConsent}</p>
        <p>{label.privateChoice}</p>
        {request.publicConsentText && <>
            <h4>{label.publicTitle}</h4><p>{pt.publicConsent}</p><p>{label.publicChoice}</p>
            <p>{label.publicVersion}: {request.publicConsentVersion}<br />{label.publicPolicy}: {request.publicPolicyDigest}</p>
        </>}
        <p>{label.guardian}</p><p>{label.name}</p><p>{label.signature}</p><p>{label.date}</p>
        <p>{label.formVersion}: {notice.signedParentForm.version} · {label.privacyVersion}: {notice.version}</p>
        <button className="signed-parent-form__print" type="button" onClick={() => window.print()}>{label.print}</button>
    </article>;
}

export default function SignedParentForm({ request, policy }: { request: SignedParentFormRequest; policy: Extract<ParentConfig, { enabled: true }> }) {
    if (request.country === 'BR') return <PortugueseSignedParentForm request={request} policy={policy} />;
    return <article className="signed-parent-form" aria-label="Signed parent consent form">
        <h3>Ludolume parent consent form</h3>
        <p>{notice.operatorName}<br />{notice.operatorAddress}<br />{notice.operatorTelephone}<br />{notice.contactEmail}</p>
        <p>{notice.signedParentForm.notice}</p>
        <p><PrivacyNoticeLink url={policy.privacyNoticeUrl} /></p>
        <dl>
            <dt>Request reference</dt><dd>{request.reference}</dd>
            <dt>Parent account</dt><dd>{request.parentAccountId}</dd>
            <dt>Verified parent email</dt><dd>{request.verifiedContact}</dd>
            {policy.credentialsAfterApproval ? <><dt>Child's country</dt><dd>{request.country}</dd></>
                : <><dt>Child's chosen nickname and country</dt><dd>{request.userName} · {request.country}</dd></>}
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
