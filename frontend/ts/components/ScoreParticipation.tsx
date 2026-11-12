import { useEffect, useRef, useState } from 'react';
import { createParentRegistrationApi, type ScoreParticipationConfig } from '@/services/parentRegistrationApi';
import { acquireProviderCredential, getAvailableProviderClients, type PublicProviderClient } from '@/services/providerClient';
import { apiFetch } from '@/services/apiFetch';
import { API_BASE } from '@/config/apiConfig';
import PrivacyNoticeLink from './PrivacyNoticeLink';
import { capturePageOwnership, requestIsCurrent } from '@/services/pageOwnership';
import type { ParentLanguage } from './parentAccountText';
import notice from '../../../shared/privacyNotice.json' with { type: 'json' };

const portugueseFeedback: Record<string, string> = {
    'Leaderboard choices could not be loaded. Please retry.': 'Não foi possível carregar as opções dos rankings. Tente novamente.',
    'Leaderboard participation is enabled.': 'A participação nos rankings está habilitada.',
    'Public entries have been removed. Your account and private scores are kept.': 'Os registros públicos foram removidos. Sua conta e seus resultados privados foram mantidos.',
    'The change could not be confirmed. Refresh before retrying. A recorded removal request may still complete.': 'Não foi possível confirmar a alteração. Atualize antes de tentar novamente. Uma solicitação de remoção registrada ainda pode ser concluída.',
    'Approval cancelled. Any submitted change may still complete; refresh to check.': 'Aprovação cancelada. Uma alteração já enviada ainda pode ser concluída; atualize para conferir.',
};

const api = createParentRegistrationApi(API_BASE, apiFetch);
export default function ScoreParticipation({ language = 'en', childAccountId = null, authenticated, accountKey, sessionGeneration, selectionIsCurrent, captureAccountAction, captureSessionGeneration, onReady }: {
    language?: ParentLanguage; childAccountId?: string | null; authenticated: boolean; accountKey: string; sessionGeneration: number; selectionIsCurrent?: () => boolean;
    captureAccountAction?: () => number; captureSessionGeneration?: () => number;
    onReady?: () => void;
}) {
    const tr = (en: string, pt: string) => language === 'pt-BR' ? pt : en;
    const [policy, setPolicy] = useState<ScoreParticipationConfig | null>(null);
    const [status, setStatus] = useState<{ visibility: 'public' | 'private'; canPublish: boolean } | null>(null);
    const [clients, setClients] = useState<PublicProviderClient[]>([]);
    const [consent, setConsent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState('');
    const [retry, setRetry] = useState(0);
    const operation = useRef<AbortController | null>(null);
    const pending = useRef<string | null>(null);
    const loadGeneration = useRef(0);
    const latest = useRef({ childAccountId, authenticated, accountKey, sessionGeneration, policy, status, consent });
    latest.current = { childAccountId, authenticated, accountKey, sessionGeneration, policy, status, consent };
    function cancel() {
        operation.current?.abort(); operation.current = null;
        const state = pending.current; pending.current = null;
        if (state) void api.cancel(state).catch(() => undefined);
    }
    useEffect(() => {
        setPolicy(null); setStatus(null); setConsent(false); setBusy(false); setFeedback('');
        return cancel;
    }, [childAccountId, authenticated, accountKey, sessionGeneration]);
    useEffect(() => {
        const controller = new AbortController();
        const generation = ++loadGeneration.current;
        if (authenticated) void Promise.all([api.scoreConfig(controller.signal), api.scoreStatus(childAccountId, controller.signal), getAvailableProviderClients()])
            .then(([next, current, available]) => { if (!controller.signal.aborted && generation === loadGeneration.current) { setPolicy(next); setStatus(current); setClients(available); } })
            .catch(() => { if (!controller.signal.aborted && generation === loadGeneration.current) setFeedback('Leaderboard choices could not be loaded. Please retry.'); })
            .finally(() => { if (!controller.signal.aborted && generation === loadGeneration.current) onReady?.(); });
        return () => controller.abort();
    }, [childAccountId, authenticated, accountKey, sessionGeneration, retry]);
    async function change(client?: PublicProviderClient) {
        if (operation.current || !authenticated || !status || client && (!consent || !policy?.enabled || !status.canPublish)) return;
        // A refresh from a preceding action must not replace the state this action owns.
        loadGeneration.current++;
        const controller = new AbortController(); const ownsPage = capturePageOwnership();
        const expectedAction = captureAccountAction?.();
        const isOwner = () => ownsPage() && requestIsCurrent(selectionIsCurrent) && latest.current.authenticated && latest.current.accountKey === accountKey
            && latest.current.sessionGeneration === sessionGeneration && latest.current.childAccountId === childAccountId
            && (!captureAccountAction || captureAccountAction() === expectedAction)
            && (!captureSessionGeneration || captureSessionGeneration() === sessionGeneration);
        const isCurrent = () => isOwner() && latest.current.policy === policy && latest.current.status === status && (!client || latest.current.consent);
        const active = () => !controller.signal.aborted && isCurrent();
        operation.current = controller; setBusy(true); setFeedback('');
        try {
            if (client && policy?.enabled) {
                const challenge = await api.beginScorePublication(policy, client.clientKey, childAccountId, controller.signal, isCurrent);
                if (!active()) { void api.cancel(challenge.state).catch(() => undefined); return; }
                pending.current = challenge.state;
                const credential = await acquireProviderCredential(client, challenge, controller.signal);
                if (!active()) return;
                const approval = await api.complete(challenge.state, typeof credential === 'string' ? credential : credential.idToken, controller.signal, isCurrent);
                if (!active()) return;
                if (approval.purpose !== 'publish-scores') throw new Error('Wrong approval purpose.');
                await api.publishScores(approval.grant, controller.signal, isCurrent);
            } else await api.withdrawScores(childAccountId, controller.signal, isCurrent);
            if (!active()) return;
            pending.current = null; setConsent(false); setRetry(value => value + 1);
            setFeedback(client ? 'Leaderboard participation is enabled.' : 'Public entries have been removed. Your account and private scores are kept.');
        } catch { if (active()) setFeedback('The change could not be confirmed. Refresh before retrying. A recorded removal request may still complete.'); }
        finally { if (operation.current === controller) { const canUpdate = !controller.signal.aborted; cancel(); if (canUpdate) setBusy(false); } }
    }
    if (!authenticated) return null;
    return <section className="score-participation" lang={language} aria-label={childAccountId ? tr('Child leaderboard participation', 'Participação da criança nos rankings') : tr('Your leaderboard participation', 'Sua participação nos rankings')}>
        <h2>{tr('Public leaderboards', 'Rankings públicos')}</h2>
        <p>{tr("Participation shows the chosen nickname and game results, including existing and future best scores. It does not show parent contact details or the account's age, country or ID.", 'A participação mostra o apelido escolhido e os resultados dos jogos, incluindo as melhores pontuações atuais e futuras. Não mostra os dados de contato do responsável nem a idade, o país ou o identificador da conta.')}</p>
        <p>{tr('Use a nickname you are comfortable making public. You can remove public entries here while keeping the account and its private scores.', 'Use um apelido que você aceite tornar público. Você pode remover os registros públicos aqui e manter a conta e seus resultados privados.')}</p>
        {status && <p className="score-participation__status">{tr('Current visibility:', 'Visibilidade atual:')} <strong>{status.visibility === 'public' ? tr('public', 'pública') : tr('private', 'privada')}</strong></p>}
        {policy?.enabled && status?.canPublish && <>
            <PrivacyNoticeLink url={policy.privacyNoticeUrl} portuguese={language === 'pt-BR'} />
            <label className="score-participation__consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span><span lang="en">{policy.consentText}</span>
                {language === 'pt-BR' && policy.consentText === notice.consent.publicScores.text && policy.consentVersion === notice.consent.publicScores.version
                    && <><br /><span lang="pt-BR">{notice.signedParentForm.ptBR.publicConsent}</span></>}</span></label>
            {clients.map(client => <button key={client.clientKey} type="button" disabled={busy || !consent}
                onClick={() => void change(client)}>{tr('Join leaderboards with', 'Participar dos rankings com')} {client.provider === 'google' ? 'Google' : 'Apple'}</button>)}
        </>}
        {status && !status.canPublish && <p>{tr('New public participation is not currently available for this account.', 'No momento, esta conta não pode iniciar uma participação pública.')}</p>}
        <button type="button" disabled={busy || !status} onClick={() => void change()}>{tr('Remove public entries', 'Remover registros públicos')}</button>
        {busy && <button type="button" onClick={() => { cancel(); setBusy(false); setConsent(false);
            setFeedback('Approval cancelled. Any submitted change may still complete; refresh to check.'); }}>{tr('Cancel approval', 'Cancelar aprovação')}</button>}
        <button type="button" disabled={busy} onClick={() => setRetry(value => value + 1)}>{tr('Refresh leaderboard choice', 'Atualizar opção dos rankings')}</button>
        {feedback && <p role="status">{language === 'pt-BR' ? portugueseFeedback[feedback] ?? feedback : feedback}</p>}
    </section>;
}
