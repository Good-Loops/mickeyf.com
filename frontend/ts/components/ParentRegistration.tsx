import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { ProviderCredential, ProviderAuthenticationChallenge } from '@/services/authApi';
import type { PublicProviderClient } from '@/services/providerClient';
import { ParentRegistrationError, type ParentRegistrationApi, type ParentConfig, type SignedParentFormRequest } from '@/services/parentRegistrationApi';
import PrivacyNoticeLink from '@/components/PrivacyNoticeLink';
import SignedParentForm, { portugueseFormAvailable, portugueseParentConsentAvailable } from './SignedParentForm';
import notice from '../../../shared/privacyNotice.json' with { type: 'json' };
import { capturePageOwnership } from '@/services/pageOwnership';

type Props = {
    api: ParentRegistrationApi;
    authenticated: boolean;
    /** Changes whenever the current account changes; never inferred from provider email. */
    accountKey: string;
    sessionGeneration?: number;
    captureAccountAction?(): number;
    captureSessionGeneration?(): number;
    clients: readonly PublicProviderClient[];
    acquire(client: PublicProviderClient, challenge: ProviderAuthenticationChallenge, signal: AbortSignal): Promise<ProviderCredential>;
    onCreated?(): void;
    requireChildAudience?: boolean;
};

/** Child credentials are collected only after a fresh, consent-bound parent approval. */
export default function ParentRegistration({ api, authenticated, accountKey, sessionGeneration = 0, captureAccountAction, captureSessionGeneration, clients, acquire, onCreated,
    requireChildAudience = false }: Props) {
    const [config, setConfig] = useState<ParentConfig | null>(null);
    const [retry, setRetry] = useState(0);
    const [country, setCountry] = useState('');
    const [adult, setAdult] = useState(false);
    const [guardian, setGuardian] = useState(false);
    const [consent, setConsent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState('');
    const [grant, setGrant] = useState<{ token: string; expiresAt: number } | null>(null);
    const [userName, setUserName] = useState('');
    const [password, setPassword] = useState('');
    const [forms, setForms] = useState<readonly SignedParentFormRequest[]>([]);
    const [selectedForm, setSelectedForm] = useState<SignedParentFormRequest | null>(null);
    const [formRefresh, setFormRefresh] = useState(0);
    const operation = useRef<AbortController | null>(null);
    const challengeState = useRef<string | null>(null);
    const generation = useRef(0);
    const previousSession = useRef(sessionGeneration);
    const latest = useRef({ authenticated, accountKey, sessionGeneration, config, country, selectedForm });
    latest.current = { authenticated, accountKey, sessionGeneration, config, country, selectedForm };
    const credentialsAfterApproval = config?.enabled === true && config.audience === 'children-included'
        && config.credentialsAfterApproval === true;
    const creationAllowed = config?.enabled === true && config.creationEnabled
        && (!requireChildAudience || credentialsAfterApproval);
    const portuguese = country === 'BR';
    const tr = (en: string, pt: string) => portuguese ? pt : en;
    const portugueseConsentUnavailable = portuguese && config?.enabled === true
        && (!portugueseParentConsentAvailable(config) || !!selectedForm && !portugueseFormAvailable(selectedForm, config));
    const pt = notice.signedParentForm.ptBR;

    const discard = () => {
        generation.current++;
        operation.current?.abort();
        operation.current = null;
        const state = challengeState.current;
        challengeState.current = null;
        if (state) void api.cancel(state).catch(() => undefined);
    };
    useEffect(() => {
        const controller = new AbortController();
        setConfig(null);
        void api.config(controller.signal).then(value => {
            if (!controller.signal.aborted) setConfig(value);
        }).catch(() => { if (!controller.signal.aborted) setFeedback('Parent registration could not be loaded. Please try again.'); });
        return () => controller.abort();
    }, [api, retry]);
    useEffect(() => () => { discard(); }, [api, authenticated, accountKey]);
    useEffect(() => {
        if (!authenticated || !config?.enabled || !config.signedFormCountries) { setForms([]); setSelectedForm(null); return; }
        const controller = new AbortController();
        void api.listSignedForms(controller.signal).then(value => {
            if (controller.signal.aborted) return;
            setForms(value); setSelectedForm(current => current ? value.find(form => form.reference === current.reference) ?? null : null);
        }).catch(() => { if (!controller.signal.aborted) setFeedback('Signed form requests could not be refreshed. Try again.'); });
        return () => controller.abort();
    }, [api, authenticated, accountKey, sessionGeneration, config, formRefresh]);
    useEffect(() => {
        setGrant(null); setPassword(''); setUserName(''); setBusy(false); setFeedback(''); setCountry('');
        setAdult(false); setGuardian(false); setConsent(false);
        setForms([]); setSelectedForm(null);
    }, [api, authenticated, accountKey]);
    useEffect(() => {
        if (previousSession.current === sessionGeneration) return;
        previousSession.current = sessionGeneration;
        discard(); setGrant(null); setPassword(''); setUserName(''); setSelectedForm(null); setBusy(false);
            setFeedback(tr('Your session was refreshed. Restart parent approval. If you submitted child details, refresh the child list first: account creation may still complete.', 'Sua sessão foi atualizada. Reinicie a aprovação do responsável. Se você enviou dados da criança, atualize primeiro a lista: a criação da conta ainda pode ser concluída.'));
    }, [sessionGeneration]);
    useEffect(() => {
        if (!grant) return;
        const timer = setTimeout(() => { discard(); setGrant(null); setPassword(''); setBusy(false);
            setFeedback(tr('The approval window ended. If you submitted child details, check whether the account was created before trying again.', 'O prazo da aprovação terminou. Se você enviou dados da criança, verifique se a conta foi criada antes de tentar novamente.')); }, Math.max(0, grant.expiresAt - Date.now()));
        return () => clearTimeout(timer);
    }, [grant]);

    const reset = () => { discard(); setGrant(null); setUserName(''); setPassword(''); setSelectedForm(null); setBusy(false);
        setFeedback(tr('Cancelled. Any unconfirmed account creation must be checked before trying again.', 'Cancelado. Verifique qualquer criação de conta não confirmada antes de tentar novamente.')); };
    const errorText = (error: unknown) => error instanceof ParentRegistrationError && error.code === 'VERIFIED_CONTACT_REQUIRED'
        ? tr('The provider did not supply a verified email. No child account was created. Try a linked provider that can confirm your email.', 'O provedor não forneceu um e-mail verificado. Nenhuma conta infantil foi criada. Tente um provedor vinculado que confirme seu e-mail.')
        : error instanceof ParentRegistrationError && error.code === 'SIGNED_FORM_REQUIRED'
        ? tr('An approved signed parent form for this exact child, country and notice is required. No child account was created.', 'É necessário um formulário assinado e aprovado para esta solicitação, país e aviso. Nenhuma conta infantil foi criada.')
        : error instanceof ParentRegistrationError && error.code === 'PROVIDER_NOT_LINKED'
        ? tr('Use the Google or Apple account already linked to your own Ludolume account.', 'Use a conta Google ou Apple já vinculada à sua própria conta Ludolume.')
        : error instanceof ParentRegistrationError && error.code === 'INVALID_ATTEMPT' && selectedForm
        ? tr('The approval could not be confirmed. Try again; if your provider’s verified email changed since you requested the form, request a new form.', 'Não foi possível confirmar a aprovação. Tente novamente; se o e-mail verificado do provedor mudou desde a solicitação, peça um novo formulário.')
        : tr('This request could not be confirmed. If you submitted child account details, check the account before trying again.', 'Não foi possível confirmar esta solicitação. Se você enviou dados da conta infantil, verifique a conta antes de tentar novamente.');

    const approve = async (client: PublicProviderClient) => {
        if (operation.current || !authenticated || !config?.enabled || !creationAllowed || !config.countries.includes(country) || !adult || !guardian || !consent) return;
        const needsForm = config.signedFormCountries?.includes(country) === true;
        if (needsForm && (selectedForm ? selectedForm.status !== 'approved' || Date.parse(selectedForm.expiresAt) <= Date.now()
            : !credentialsAfterApproval && !userName.trim())) return;
        const controller = new AbortController(); operation.current = controller;
        const current = ++generation.current;
        const expectedAction = captureAccountAction?.();
        const ownsPage = capturePageOwnership();
        const isOwner = () => ownsPage() && latest.current.authenticated && latest.current.accountKey === accountKey
            && latest.current.sessionGeneration === sessionGeneration
            && (!captureAccountAction || captureAccountAction() === expectedAction)
            && (!captureSessionGeneration || captureSessionGeneration() === sessionGeneration);
        const isCurrent = () => isOwner() && latest.current.config === config
            && latest.current.country === country && latest.current.selectedForm === selectedForm;
        const active = () => current === generation.current && !controller.signal.aborted && isCurrent();
        setBusy(true); setFeedback('');
        try {
            const challenge = await api.begin(config, client.clientKey,
                { country, adultAttestation: true, guardianAttestation: true, consent: true }, controller.signal, isCurrent,
                credentialsAfterApproval ? selectedForm?.reference : undefined);
            if (!active()) { void api.cancel(challenge.state).catch(() => undefined); return; }
            challengeState.current = challenge.state;
            const credential = await acquire(client, challenge, controller.signal);
            if (!active()) return;
            if (needsForm && !selectedForm) {
                const form = await api.requestSignedForm(challenge.state, typeof credential === 'string' ? credential : credential.idToken,
                    credentialsAfterApproval ? undefined : userName, controller.signal, isCurrent);
                if (!active()) return;
                challengeState.current = null; setSelectedForm(form); setForms(current => [form, ...current]);
                setFeedback(tr('Print and sign the form. We will email the verified parent address; check Spam and reply to that message with the signed scan or photo. The child account has not been created.', 'Imprima e assine o formulário. Enviaremos uma mensagem ao e-mail verificado do responsável; confira o Spam e responda com a digitalização ou foto assinada. A conta infantil ainda não foi criada.'));
                return;
            }
            const proof = await api.complete(challenge.state, typeof credential === 'string' ? credential : credential.idToken, controller.signal, isCurrent);
            if (!active()) return;
            if (proof.purpose !== 'create-child') throw new ParentRegistrationError('UNAVAILABLE');
            setGrant({ token: proof.grant, expiresAt: Date.now() + proof.expiresInSeconds * 1000 });
        } catch (error) {
            if (active()) { const state = challengeState.current; challengeState.current = null;
                if (state) void api.cancel(state).catch(() => undefined); setFeedback(errorText(error)); }
        } finally { if (current === generation.current && operation.current === controller) {
            if (!active()) { const state = challengeState.current; challengeState.current = null;
                if (state) void api.cancel(state).catch(() => undefined); }
            operation.current = null; if (!controller.signal.aborted) setBusy(false);
        } }
    };
    const create = async (event: FormEvent) => {
        event.preventDefault();
        if (operation.current || !authenticated || !grant || grant.expiresAt <= Date.now()) return;
        const controller = new AbortController(); operation.current = controller;
        const current = ++generation.current;
        const expectedAction = captureAccountAction?.();
        const ownsPage = capturePageOwnership();
        const isCurrent = () => ownsPage() && latest.current.authenticated && latest.current.accountKey === accountKey
            && latest.current.sessionGeneration === sessionGeneration && latest.current.config === config
            && (!captureAccountAction || captureAccountAction() === expectedAction)
            && (!captureSessionGeneration || captureSessionGeneration() === sessionGeneration)
            && latest.current.selectedForm === selectedForm;
        const active = () => current === generation.current && !controller.signal.aborted && isCurrent();
        setBusy(true); setFeedback('');
        try {
            const child = await api.createChild(grant.token, userName, password, controller.signal, selectedForm?.reference, isCurrent);
            if (!active()) return;
            challengeState.current = null; setGrant(null); setUserName(''); setPassword('');
            setFeedback(tr(`Created ${child.userName} with private scores. You are still signed in to your parent account.`, `A conta ${child.userName} foi criada com resultados privados. Você continua conectado à conta de responsável.`));
            setSelectedForm(null); setFormRefresh(value => value + 1);
            onCreated?.();
        } catch (error) { if (active()) {
            discard(); setGrant(null); setPassword(''); setBusy(false); setFeedback(errorText(error));
        } } finally { if (current === generation.current && operation.current === controller) { operation.current = null; if (!controller.signal.aborted) setBusy(false); } }
    };
    const selectForm = (form: SignedParentFormRequest) => {
        discard(); setGrant(null); setPassword(''); setBusy(false); setSelectedForm(form); setCountry(form.country);
        setUserName(credentialsAfterApproval ? '' : form.userName ?? '');
        setAdult(false); setGuardian(false); setConsent(false);
        setFeedback(form.country === 'BR'
            ? form.status === 'approved' ? 'Formulário assinado aprovado. Confirme novamente com o mesmo provedor vinculado e depois escolha a senha da criança.'
                : form.status === 'rejected' ? 'O formulário não foi aprovado. A conta infantil não foi criada; cancele esta solicitação para iniciar outra ou entre em contato para obter ajuda.'
                    : 'Esta conta infantil ainda não foi criada. Verifique a caixa de entrada e o Spam, responda à nossa mensagem com o formulário assinado e aguarde a análise.'
            : form.status === 'approved' ? 'Signed form approved. Confirm again with the same linked provider, then choose the child password.'
                : form.status === 'rejected' ? 'The form was not approved. No child account was created; cancel this request to start another, or contact us for help.'
                    : 'This child account has not been created. Check your inbox and Spam for our email, reply with the signed form, and wait for review.');
    };
    const cancelForm = async () => {
        if (!selectedForm || operation.current) return;
        const controller = new AbortController(); operation.current = controller;
        const current = ++generation.current;
        setBusy(true);
        try {
            await api.cancelSignedForm(selectedForm.reference, controller.signal);
            if (current !== generation.current || controller.signal.aborted) return;
            setSelectedForm(null); setCountry(''); setUserName(''); setFormRefresh(value => value + 1);
            setFeedback(tr('Signed form request cancelled. If you sent a form by email, contact us to request removal of the copy.', 'Solicitação do formulário cancelada. Se você enviou um formulário por e-mail, entre em contato para solicitar a remoção da cópia.'));
        } catch { if (current === generation.current && !controller.signal.aborted) setFeedback(tr('Cancellation could not be confirmed. Refresh the requests before trying again.', 'Não foi possível confirmar o cancelamento. Atualize as solicitações antes de tentar novamente.')); }
        finally { if (current === generation.current && !controller.signal.aborted) { operation.current = null; setBusy(false); } }
    };

    return <section aria-label={tr('Parent-led registration', 'Cadastro por responsável')}>
        <h2>{tr('Create a private child account', 'Criar uma conta infantil privada')}</h2>
        <p>{tr('Google or Apple confirms your provider account and may confirm your email. Your adult and guardian declarations are separate; provider sign-in does not verify guardianship.', 'Google ou Apple confirma sua conta no provedor e pode confirmar seu e-mail. Suas declarações de maioridade e responsabilidade legal são separadas; o acesso pelo provedor não comprova responsabilidade legal.')}</p>
        {config?.enabled && <p><PrivacyNoticeLink url={config.privacyNoticeUrl} portuguese={portuguese} /></p>}
        {authenticated && config?.enabled && config.signedFormCountries && <div>
            <button type="button" disabled={busy} onClick={() => setFormRefresh(value => value + 1)}>{tr('Refresh signed form requests', 'Atualizar solicitações de formulário assinado')}</button>
            {forms.map(form => <button type="button" key={form.reference} disabled={busy} onClick={() => selectForm(form)}>{form.userName ?? (form.country === 'BR' ? 'Solicitação de conta infantil' : 'Child account request')}: {form.country === 'BR' ? ({ pending: 'pendente', approved: 'aprovado', rejected: 'recusado' } as const)[form.status] : form.status}</button>)}
            {selectedForm && <>
                {selectedForm.status !== 'rejected' && <SignedParentForm request={selectedForm} policy={config} />}
                <button type="button" disabled={busy} onClick={() => void cancelForm()}>{tr('Cancel this signed form request', 'Cancelar esta solicitação de formulário assinado')}</button>
            </>}
        </div>}
        {!authenticated ? <p><Link to="/login">Log in to your own Ludolume account with Google or Apple</Link>, then return here.</p>
            : !config ? <button type="button" onClick={() => setRetry(value => value + 1)}>Retry loading parent registration</button>
            : !config.enabled ? <p>Parent registration is not available on this server.</p>
            : !creationAllowed ? <p>New child accounts are paused. Existing child accounts can still be managed below.</p>
            : grant ? <form onSubmit={create}>
                <p>{tr("Scores are private. No child email or date of birth is collected. Choose a nickname, not the child's real name.", 'Os resultados são privados. Nenhum e-mail ou data de nascimento da criança é coletado. Escolha um apelido, não o nome real da criança.')}</p>
                <p>{tr("Keep the child's password safe. This version cannot recover it; deleting and recreating the account also deletes its saved results.", 'Guarde a senha da criança em segurança. Esta versão não permite recuperá-la; excluir e recriar a conta também exclui os resultados salvos.')}</p>
                <label>{tr("Child's nickname", 'Apelido da criança')}<input required maxLength={64} value={userName} disabled={busy || !!selectedForm && !credentialsAfterApproval} onChange={event => setUserName(event.target.value)} /></label>
                <label>{tr("Child's password", 'Senha da criança')}<input type="password" autoComplete="new-password" required minLength={8} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
                <button type="submit" disabled={busy}>{tr('Create private child account', 'Criar conta infantil privada')}</button>
            </form> : <div>
                <label>{portuguese ? 'País da criança' : "Child's country / País da criança"}<select value={country} disabled={busy || !!selectedForm} onChange={event => {
                    setCountry(event.target.value); setAdult(false); setGuardian(false); setConsent(false);
                }}>
                    <option value="">{tr('Choose a country / Escolha um país', 'Escolha um país')}</option>{config.countries.map(value => <option key={value} value={value}>{value}</option>)}
                </select></label>
                {config.signedFormCountries?.includes(country) && selectedForm?.status !== 'rejected' && <>
                    <p lang={portuguese ? 'pt-BR' : undefined}>{portuguese ? pt.notice : notice.signedParentForm.notice}</p>
                    {!selectedForm && !credentialsAfterApproval && <label>{tr("Child's chosen nickname", 'Apelido escolhido para a criança')}<input maxLength={64} value={userName} disabled={busy} onChange={event => setUserName(event.target.value)} /></label>}
                    {credentialsAfterApproval && <p>{portuguese ? pt.labels.credentialsAfterApproval : "The child's nickname and password are chosen only after the signed parent form is approved."}</p>}
                    {selectedForm?.status === 'pending' && <p>{portuguese ? pt.labels.awaiting : 'Awaiting signed form return or review. The child account is not active.'}</p>}
                </>}
                <label><input type="checkbox" checked={adult} disabled={busy} onChange={event => setAdult(event.target.checked)} />{portuguese ? pt.labels.adult : 'I am 18 or older.'}</label>
                <label><input type="checkbox" checked={guardian} disabled={busy} onChange={event => setGuardian(event.target.checked)} />{portuguese ? pt.labels.guardianCheck : "I am this child's parent or legal guardian and can give this consent."}</label>
                {portugueseConsentUnavailable ? <p lang="pt-BR" role="alert">{pt.labels.unavailable}</p>
                    : <p lang={portuguese ? 'pt-BR' : undefined}>{portuguese ? pt.parentConsent : config.consentText}</p>}
                <label><input type="checkbox" checked={consent} disabled={busy || portugueseConsentUnavailable} onChange={event => setConsent(event.target.checked)} />{portuguese ? pt.labels.consentCheck : 'I agree to this child-account consent.'}</label>
                {clients.map(client => <button type="button" key={client.clientKey} disabled={busy || portugueseConsentUnavailable || !country || !adult || !guardian || !consent
                    || !!config.signedFormCountries?.includes(country) && (selectedForm ? selectedForm.status !== 'approved' : !credentialsAfterApproval && !userName.trim())}
                    onClick={() => void approve(client)}>{tr('Confirm with', 'Confirmar com')} {client.provider === 'google' ? 'Google' : 'Apple'}</button>)}
                {clients.length === 0 && <p>{tr('No supported provider is available here. No child details are needed.', 'Nenhum provedor compatível está disponível aqui. Não são necessários dados da criança.')}</p>}
            </div>}
        <button type="button" onClick={reset}>{tr('Cancel parent registration', 'Cancelar cadastro por responsável')}</button>
        {feedback && <p lang={portuguese ? 'pt-BR' : undefined} role="status">{feedback}</p>}
    </section>;
}
