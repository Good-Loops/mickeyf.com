import notice from '../../../shared/privacyNotice.json' with { type: 'json' };
import { useRef, useState, type RefObject } from 'react';
import { Capacitor } from '@capacitor/core';
import type { SignedParentFormRequest, ParentConfig } from '@/services/parentRegistrationApi';
import PrivacyNoticeLink from './PrivacyNoticeLink';
import { parsePrivacyNoticeUrl } from '@/config/privacyNoticeUrl';
import './SignedParentForm.css';

/** Use the displayed form itself so that the copied consent cannot drift from the printed wording. */
export function formTextForCopy(content: Pick<HTMLElement, 'innerText' | 'querySelector'>): string {
    const privacyUrl = content.querySelector<HTMLAnchorElement>('a[href]')?.href;
    return `${content.innerText.trim()}${privacyUrl ? `\n\nPrivacy notice / Aviso de privacidade: ${privacyUrl}` : ''}`;
}

function FormActions({ contentRef, portuguese, allowCopy }: {
    contentRef: RefObject<HTMLDivElement | null>; portuguese: boolean; allowCopy: boolean;
}) {
    const [formText, setFormText] = useState('');
    const [copied, setCopied] = useState(false);
    const prepareText = () => {
        if (!contentRef.current) return;
        setCopied(false);
        setFormText(formTextForCopy(contentRef.current));
    };
    const copyText = async () => {
        try {
            await navigator.clipboard.writeText(formText);
            setCopied(true);
        } catch {
            setCopied(false);
        }
    };
    return <div className="signed-parent-form__actions">
        {(Capacitor.getPlatform() !== 'android' || !allowCopy) && <button type="button" onClick={() => window.print()}>
            {portuguese ? notice.signedParentForm.ptBR.labels.print : 'Print signed parent form'}
        </button>}
        {allowCopy && <>
            <button type="button" onClick={prepareText}>{portuguese ? 'Preparar texto do formulário' : 'Prepare form text'}</button>
            {formText && <div>
                <p>{portuguese
                    ? 'Copie o texto sem alterá-lo para um documento, imprima e assine à mão. Responda à nossa mensagem com uma foto ou digitalização assinada. O texto contém seu e-mail, identificador da conta, país e referência da solicitação.'
                    : 'Copy the unchanged text into a document, print it, and sign it by hand. Reply to our message with a signed photo or scan. The text contains your email, account ID, country, and request reference.'}</p>
                <label>{portuguese ? 'Texto do formulário' : 'Form text'}
                    <textarea readOnly value={formText} onFocus={event => event.currentTarget.select()} rows={8} />
                </label>
                <button type="button" onClick={copyText}>{portuguese ? 'Copiar texto' : 'Copy text'}</button>
                <p role="status">{copied
                    ? portuguese ? 'Texto copiado.' : 'Text copied.'
                    : portuguese ? 'Se o botão não funcionar, selecione e copie o texto acima.' : 'If the button does not work, select and copy the text above.'}</p>
            </div>}
        </>}
    </div>;
}

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
    const contentRef = useRef<HTMLDivElement>(null);
    const pt = notice.signedParentForm.ptBR;
    const label = pt.labels;
    const privacyUrl = parsePrivacyNoticeUrl(policy.privacyNoticeUrl);
    if (!portugueseFormAvailable(request, policy) || !privacyUrl) {
        return <p lang="pt-BR" role="alert">{label.unavailable}</p>;
    }
    return <article className="signed-parent-form" lang="pt-BR" aria-label={label.formAria}>
        <div ref={contentRef}>
        <h3>{label.title}</h3>
        <p>{notice.operatorName}<br />{notice.operatorAddress}<br />{notice.operatorTelephone}<br />{notice.contactEmail}</p>
        <p>{pt.notice}</p>
        <p><a href={`${privacyUrl.split('#')[0]}#portugues`} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{label.privacy}</a></p>
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
        </div>
        <FormActions key={request.reference} contentRef={contentRef} portuguese allowCopy={policy.credentialsAfterApproval === true} />
    </article>;
}

export default function SignedParentForm({ request, policy }: { request: SignedParentFormRequest; policy: Extract<ParentConfig, { enabled: true }> }) {
    const contentRef = useRef<HTMLDivElement>(null);
    if (request.country === 'BR') return <PortugueseSignedParentForm request={request} policy={policy} />;
    return <article className="signed-parent-form" aria-label="Signed parent consent form">
        <div ref={contentRef}>
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
        </div>
        <FormActions key={request.reference} contentRef={contentRef} portuguese={false} allowCopy={policy.credentialsAfterApproval === true} />
    </article>;
}
