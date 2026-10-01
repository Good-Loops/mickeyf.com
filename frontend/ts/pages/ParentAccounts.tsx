import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import ParentRegistration from '@/components/ParentRegistration';
import { createParentRegistrationApi, type ParentConfig } from '@/services/parentRegistrationApi';
import { acquireProviderCredential, getAvailableProviderClients, type PublicProviderClient } from '@/services/providerClient';
import { apiFetch } from '@/services/apiFetch';
import { API_BASE, LEGACY_PUBLIC_API_PREVIEW } from '@/config/apiConfig';

const api = createParentRegistrationApi(API_BASE, apiFetch);
export default function ParentAccounts() {
    const { isAuthenticated, userName, loading, sessionGeneration } = useAuth();
    const [clients, setClients] = useState<PublicProviderClient[]>([]);
    const [config, setConfig] = useState<ParentConfig | null>(null);
    const [children, setChildren] = useState<{ accountId: string; userName: string }[]>([]);
    const [retry, setRetry] = useState(0);
    const [confirmation, setConfirmation] = useState('');
    const [selected, setSelected] = useState('');
    const [feedback, setFeedback] = useState('');
    const [busy, setBusy] = useState(false);
    const operation = useRef<AbortController | null>(null);
    const pendingState = useRef<string | null>(null);
    const previousSession = useRef(sessionGeneration);
    useEffect(() => { setFeedback(''); }, [isAuthenticated, userName]);
    useEffect(() => {
        setChildren([]); setConfig(null); setSelected(''); setConfirmation(''); setBusy(false);
        if (previousSession.current !== sessionGeneration) {
            previousSession.current = sessionGeneration;
            setFeedback('Your session was refreshed. Restart parent approval. Any submitted deletion may still complete; refresh the child list before retrying.');
        }
        return () => { operation.current?.abort(); operation.current = null;
            const state = pendingState.current; pendingState.current = null;
            if (state) void api.cancel(state).catch(() => undefined); };
    }, [isAuthenticated, userName, loading, sessionGeneration]);
    useEffect(() => {
        const controller = new AbortController();
        if (!LEGACY_PUBLIC_API_PREVIEW && isAuthenticated && !loading) {
            void Promise.all([api.config(controller.signal), getAvailableProviderClients()]).then(async ([policy, available]) => {
                if (controller.signal.aborted) return;
                setConfig(policy); setClients(available);
                if (policy.enabled) {
                    const current = await api.listChildren(controller.signal);
                    if (!controller.signal.aborted) setChildren(current);
                }
            }).catch(() => { if (!controller.signal.aborted) setFeedback('Child accounts could not be loaded. Please retry.'); });
        }
        // Refreshing the list must not cancel an independent in-flight withdrawal.
        return () => controller.abort();
    }, [isAuthenticated, userName, loading, sessionGeneration, retry]);
    async function withdraw(client: PublicProviderClient) {
        if (operation.current || !isAuthenticated || !config?.enabled || confirmation !== 'WITHDRAW AND DELETE'
            || !children.some(child => child.accountId === selected)) return;
        const controller = new AbortController(); operation.current = controller; setBusy(true); setFeedback('');
        try {
            const challenge = await api.beginWithdrawal(config, client.clientKey, selected, controller.signal);
            if (controller.signal.aborted) { void api.cancel(challenge.state).catch(() => undefined); return; }
            pendingState.current = challenge.state;
            const credential = await acquireProviderCredential(client, challenge, controller.signal);
            if (controller.signal.aborted) return;
            const approved = await api.complete(challenge.state, typeof credential === 'string' ? credential : credential.idToken, controller.signal);
            if (controller.signal.aborted) return;
            if (approved.purpose !== 'withdraw-child') throw new Error('Invalid purpose.');
            await api.withdraw(approved.grant, controller.signal);
            if (controller.signal.aborted) return;
            pendingState.current = null; setFeedback('Consent withdrawn and child account deleted. Your parent account is unchanged.');
            setRetry(value => value + 1);
        } catch { if (!controller.signal.aborted) setFeedback('Deletion could not be confirmed. A recorded request may still complete. Refresh the child list before retrying.'); }
        finally { if (!controller.signal.aborted) { const state = pendingState.current; pendingState.current = null;
            if (state) void api.cancel(state).catch(() => undefined); operation.current = null; setBusy(false); } }
    }
    if (LEGACY_PUBLIC_API_PREVIEW) return <p>Parent accounts are unavailable in this preview.</p>;
    return <section className="manage-account"><div className="manage-account__form-wrapper">
        <h1>Parent and child accounts</h1>
        {loading ? <p>Checking your session.</p> : <ParentRegistration api={api} authenticated={isAuthenticated}
            accountKey={userName ?? ''} sessionGeneration={sessionGeneration} clients={clients} acquire={acquireProviderCredential} onCreated={() => setRetry(value => value + 1)} />}
        {isAuthenticated && config?.enabled && <section aria-label="Manage child accounts">
            <h2>Your child accounts</h2>
            <p>Child scores are private. Keep the child's password safe. This release has no email recovery for children; you can withdraw consent and delete their account here.</p>
            <button type="button" disabled={busy} onClick={() => setRetry(value => value + 1)}>Refresh child accounts</button>
            {children.length === 0 ? <p>No child accounts are listed.</p> : <>
                <label>Child account<select disabled={busy} value={selected} onChange={event => { setSelected(event.target.value); setConfirmation(''); }}>
                    <option value="">Choose the child account</option>{children.map(child => <option key={child.accountId} value={child.accountId}>{child.userName}</option>)}
                </select></label>
                <p>Withdrawing consent permanently deletes this child's account and scores and signs out its devices. It cannot be undone.</p>
                <label>Type WITHDRAW AND DELETE<input disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
                {clients.map(client => <button key={client.clientKey} type="button" disabled={busy || !selected || confirmation !== 'WITHDRAW AND DELETE'}
                    onClick={() => void withdraw(client)}>Confirm deletion with {client.provider === 'google' ? 'Google' : 'Apple'}</button>)}
            </>}
        </section>}
        {feedback && <p role="status">{feedback}</p>}<p><Link to="/account">Manage your own account</Link></p>
    </div></section>;
}
