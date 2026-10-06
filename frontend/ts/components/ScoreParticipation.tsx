import { useEffect, useRef, useState } from 'react';
import { createParentRegistrationApi, type ScoreParticipationConfig } from '@/services/parentRegistrationApi';
import { acquireProviderCredential, getAvailableProviderClients, type PublicProviderClient } from '@/services/providerClient';
import { apiFetch } from '@/services/apiFetch';
import { API_BASE } from '@/config/apiConfig';
import PrivacyNoticeLink from './PrivacyNoticeLink';

const api = createParentRegistrationApi(API_BASE, apiFetch);
export default function ScoreParticipation({ childAccountId = null, authenticated, accountKey, sessionGeneration }: {
    childAccountId?: string | null; authenticated: boolean; accountKey: string; sessionGeneration: number;
}) {
    const [policy, setPolicy] = useState<ScoreParticipationConfig | null>(null);
    const [status, setStatus] = useState<{ visibility: 'public' | 'private'; canPublish: boolean } | null>(null);
    const [clients, setClients] = useState<PublicProviderClient[]>([]);
    const [consent, setConsent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState('');
    const [retry, setRetry] = useState(0);
    const operation = useRef<AbortController | null>(null);
    const pending = useRef<string | null>(null);
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
        if (authenticated) void Promise.all([api.scoreConfig(controller.signal), api.scoreStatus(childAccountId, controller.signal), getAvailableProviderClients()])
            .then(([next, current, available]) => { if (!controller.signal.aborted) { setPolicy(next); setStatus(current); setClients(available); } })
            .catch(() => { if (!controller.signal.aborted) setFeedback('Leaderboard choices could not be loaded. Please retry.'); });
        return () => controller.abort();
    }, [childAccountId, authenticated, accountKey, sessionGeneration, retry]);
    async function change(client?: PublicProviderClient) {
        if (operation.current || !authenticated || !status || client && (!consent || !policy?.enabled || !status.canPublish)) return;
        const controller = new AbortController(); operation.current = controller; setBusy(true); setFeedback('');
        try {
            if (client && policy?.enabled) {
                const challenge = await api.beginScorePublication(policy, client.clientKey, childAccountId, controller.signal);
                if (controller.signal.aborted) { void api.cancel(challenge.state).catch(() => undefined); return; }
                pending.current = challenge.state;
                const credential = await acquireProviderCredential(client, challenge, controller.signal);
                if (controller.signal.aborted) return;
                const approval = await api.complete(challenge.state, typeof credential === 'string' ? credential : credential.idToken, controller.signal);
                if (controller.signal.aborted) return;
                if (approval.purpose !== 'publish-scores') throw new Error('Wrong approval purpose.');
                await api.publishScores(approval.grant, controller.signal);
            } else await api.withdrawScores(childAccountId, controller.signal);
            if (controller.signal.aborted) return;
            pending.current = null; setConsent(false); setRetry(value => value + 1);
            setFeedback(client ? 'Leaderboard participation is enabled.' : 'Public entries have been removed. Your account and private scores are kept.');
        } catch { if (!controller.signal.aborted) setFeedback('The change could not be confirmed. Refresh before retrying. A recorded removal request may still complete.'); }
        finally { if (!controller.signal.aborted) { cancel(); setBusy(false); } }
    }
    if (!authenticated) return null;
    return <section aria-label={childAccountId ? 'Child leaderboard participation' : 'Your leaderboard participation'}>
        <h2>Public leaderboards</h2>
        <p>Participation shows the chosen nickname and game results, including existing and future best scores. It does not show parent contact details or the account's age, country or ID.</p>
        <p>Use a nickname you are comfortable making public. You can remove public entries here while keeping the account and its private scores.</p>
        {status && <p>Current visibility: {status.visibility}.</p>}
        {policy?.enabled && status?.canPublish && <>
            <PrivacyNoticeLink url={policy.privacyNoticeUrl} />
            <label><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />{policy.consentText}</label>
            {clients.map(client => <button key={client.clientKey} type="button" disabled={busy || !consent}
                onClick={() => void change(client)}>Join leaderboards with {client.provider === 'google' ? 'Google' : 'Apple'}</button>)}
        </>}
        {status && !status.canPublish && <p>New public participation is not currently available for this account.</p>}
        <button type="button" disabled={busy || !status} onClick={() => void change()}>Remove public entries</button>
        {busy && <button type="button" onClick={() => { cancel(); setBusy(false); setConsent(false);
            setFeedback('Approval cancelled. Any submitted change may still complete; refresh to check.'); }}>Cancel approval</button>}
        <button type="button" disabled={busy} onClick={() => setRetry(value => value + 1)}>Refresh leaderboard choice</button>
        {feedback && <p role="status">{feedback}</p>}
    </section>;
}
