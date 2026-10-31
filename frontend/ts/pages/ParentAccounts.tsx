import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import ScoreParticipation from '@/components/ScoreParticipation';
import ParentRegistration from '@/components/ParentRegistration';
import { createParentRegistrationApi, type ParentConfig } from '@/services/parentRegistrationApi';
import { acquireProviderCredential, getAvailableProviderClients, type PublicProviderClient } from '@/services/providerClient';
import { apiFetch } from '@/services/apiFetch';
import { API_BASE, LEGACY_PUBLIC_API_PREVIEW } from '@/config/apiConfig';
import { providerAccountMethodsRequest } from '@/services/authService';
import { capturePageOwnership, sameAccountIds } from '@/services/pageOwnership';
import type { PageRequestInit } from '@/services/pageOwnership';

const api = createParentRegistrationApi(API_BASE, apiFetch, { requireChildAudience: true });
export default function ParentAccounts() {
    const { isAuthenticated, userName, loading, sessionGeneration, deleteFamily: deleteFamilyAccount, captureAccountAction, captureSessionGeneration } = useAuth();
    const [clients, setClients] = useState<PublicProviderClient[]>([]);
    const [config, setConfig] = useState<ParentConfig | null>(null);
    const [children, setChildren] = useState<{ accountId: string; userName: string }[]>([]);
    const [retry, setRetry] = useState(0);
    const [confirmation, setConfirmation] = useState('');
    const [familyConfirmation, setFamilyConfirmation] = useState('');
    const [familyAcknowledged, setFamilyAcknowledged] = useState(false);
    const [childrenLoaded, setChildrenLoaded] = useState(false);
    const [selected, setSelected] = useState('');
    const [feedback, setFeedback] = useState('');
    const [busy, setBusy] = useState(false);
    const operation = useRef<AbortController | null>(null);
    const pendingState = useRef<string | null>(null);
    const previousSession = useRef(sessionGeneration);
    const selectedNow = useRef(selected);
    selectedNow.current = selected;
    const latest = useRef({ isAuthenticated, userName, loading, sessionGeneration, children, childrenLoaded, selected, confirmation, familyAcknowledged, familyConfirmation });
    latest.current = { isAuthenticated, userName, loading, sessionGeneration, children, childrenLoaded, selected, confirmation, familyAcknowledged, familyConfirmation };
    useEffect(() => { setFeedback(''); }, [isAuthenticated, userName]);
    useEffect(() => {
        setChildren([]); setChildrenLoaded(false); setFamilyConfirmation(''); setFamilyAcknowledged(false); setConfig(null); setSelected(''); setConfirmation(''); setBusy(false);
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
        setChildrenLoaded(false); setFamilyAcknowledged(false); setFamilyConfirmation('');
        if (!LEGACY_PUBLIC_API_PREVIEW && isAuthenticated && !loading) {
            void Promise.all([api.config(controller.signal), providerAccountMethodsRequest()]).then(async ([policy, methods]) => {
                const available = methods?.providerCollectionAllowed === false ? [] : await getAvailableProviderClients();
                if (controller.signal.aborted) return;
                setConfig(policy); setClients(available);
                if (policy.enabled) {
                    const current = await api.listChildren(controller.signal);
                    if (!controller.signal.aborted) { setChildren(current); setChildrenLoaded(true); }
                }
            }).catch(() => { if (!controller.signal.aborted) setFeedback('Child accounts could not be loaded. Please retry.'); });
        }
        // Refreshing the list must not cancel an independent in-flight withdrawal.
        return () => controller.abort();
    }, [isAuthenticated, userName, loading, sessionGeneration, retry]);
    async function keepChild() {
        if (operation.current || !isAuthenticated || !children.some(child => child.accountId === selected)) return;
        const controller = new AbortController(); const ownsPage = capturePageOwnership();
        const target = selected, account = userName, generation = sessionGeneration, action = captureAccountAction();
        const isCurrent = () => ownsPage() && latest.current.isAuthenticated && !latest.current.loading
            && latest.current.userName === account && latest.current.sessionGeneration === generation
            && captureSessionGeneration() === generation && captureAccountAction() === action
            && latest.current.selected === target && latest.current.children.some(child => child.accountId === target);
        operation.current = controller; setBusy(true); setFeedback('');
        try {
            const init: PageRequestInit = { method: 'POST', credentials: 'include', signal: controller.signal,
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ childAccountId: target }), isCurrent };
            if (!isCurrent()) return;
            const response = await apiFetch(`${API_BASE}/auth/child-activity/keep`, init);
            if (!response.ok) throw new Error('Request unavailable.');
            if (!controller.signal.aborted && isCurrent()) setFeedback('This child account has been kept active.');
        } catch { if (!controller.signal.aborted && isCurrent()) setFeedback('We could not confirm that this child account was kept active. Please try again.'); }
        finally { if (operation.current === controller) { operation.current = null; if (!controller.signal.aborted) setBusy(false); } }
    }
    async function withdraw(client: PublicProviderClient) {
        if (operation.current || !isAuthenticated || !config?.enabled || confirmation !== 'WITHDRAW AND DELETE'
            || !children.some(child => child.accountId === selected)) return;
        const controller = new AbortController(); const ownsPage = capturePageOwnership();
        const target = selected, account = userName, generation = sessionGeneration, expectedAction = captureAccountAction();
        const isOwner = () => ownsPage() && latest.current.isAuthenticated && !latest.current.loading
            && latest.current.userName === account && latest.current.sessionGeneration === generation && captureSessionGeneration() === generation
            && captureAccountAction() === expectedAction;
        const isCurrent = () => isOwner()
            && latest.current.selected === target && latest.current.confirmation === 'WITHDRAW AND DELETE'
            && latest.current.children.some(child => child.accountId === target);
        const active = () => !controller.signal.aborted && isCurrent();
        operation.current = controller; setBusy(true); setFeedback('');
        try {
            const challenge = await api.beginWithdrawal(config, client.clientKey, selected, controller.signal, isCurrent);
            if (!active()) { void api.cancel(challenge.state).catch(() => undefined); return; }
            pendingState.current = challenge.state;
            const credential = await acquireProviderCredential(client, challenge, controller.signal);
            if (!active()) return;
            const approved = await api.complete(challenge.state, typeof credential === 'string' ? credential : credential.idToken, controller.signal, isCurrent);
            if (!active()) return;
            if (approved.purpose !== 'withdraw-child') throw new Error('Invalid purpose.');
            await api.withdraw(approved.grant, controller.signal, isCurrent);
            if (!active()) return;
            pendingState.current = null; setFeedback('Consent withdrawn and child account deleted. Your parent account is unchanged.');
            setRetry(value => value + 1);
        } catch { if (active()) setFeedback('Deletion could not be confirmed. A recorded request may still complete. Refresh the child list before retrying.'); }
        finally { if (operation.current === controller) { const state = pendingState.current; pendingState.current = null;
            if (state) void api.cancel(state).catch(() => undefined); operation.current = null; if (!controller.signal.aborted) setBusy(false); } }
    }
    async function deleteFamily(client: PublicProviderClient) {
        if (operation.current || !isAuthenticated || !config?.enabled || !childrenLoaded
            || !familyAcknowledged || familyConfirmation !== 'DELETE MY FAMILY') return;
        const ids = children.map(child => child.accountId);
        const controller = new AbortController(); const ownsPage = capturePageOwnership();
        const account = userName, generation = sessionGeneration, expectedAction = captureAccountAction();
        const isOwner = () => ownsPage() && latest.current.isAuthenticated && !latest.current.loading
            && latest.current.userName === account && latest.current.sessionGeneration === generation && captureSessionGeneration() === generation;
        const isPageCurrent = () => isOwner()
            && latest.current.childrenLoaded && latest.current.familyAcknowledged && latest.current.familyConfirmation === 'DELETE MY FAMILY'
            && sameAccountIds(ids, latest.current.children.map(child => child.accountId));
        const isCurrent = () => isPageCurrent() && captureAccountAction() === expectedAction;
        const active = () => !controller.signal.aborted && isCurrent();
        let deletionAction: number | null = null;
        const canUpdate = () => !controller.signal.aborted && isOwner()
            && captureAccountAction() === (deletionAction ?? expectedAction);
        operation.current = controller; setBusy(true); setFeedback('');
        try {
            const challenge = await api.beginFamilyDeletion(config, client.clientKey, ids, controller.signal, isCurrent);
            if (!active()) { void api.cancel(challenge.state).catch(() => undefined); return; }
            pendingState.current = challenge.state;
            const credential = await acquireProviderCredential(client, challenge, controller.signal);
            if (!active()) return;
            const approval = await api.complete(challenge.state, typeof credential === 'string' ? credential : credential.idToken, controller.signal, isCurrent);
            if (!active()) return;
            if (approval.purpose !== 'delete-family') throw new Error('Invalid purpose.');
            const request = deleteFamilyAccount(approval.grant, ids, expectedAction, { signal: controller.signal, isCurrent: isPageCurrent });
            deletionAction = captureAccountAction();
            await request;
            if (!canUpdate()) return;
            pendingState.current = null;
        } catch { if (canUpdate()) setFeedback('Family deletion could not be confirmed. Recorded requests may still complete. Refresh the list before retrying; a changed family needs a new confirmation.'); }
        finally { if (operation.current === controller) { const state = pendingState.current; pendingState.current = null;
            if (state) void api.cancel(state).catch(() => undefined); operation.current = null; if (!controller.signal.aborted) setBusy(false); } }
    }
    if (LEGACY_PUBLIC_API_PREVIEW) return <p>Parent accounts are unavailable in this preview.</p>;
    return <section className="manage-account parent-accounts"><div className="manage-account__form-wrapper">
        <h1 className="manage-account__title">Parent and child accounts</h1>
        {loading ? <p>Checking your session.</p> : <ParentRegistration api={api} authenticated={isAuthenticated}
            requireChildAudience
            accountKey={userName ?? ''} sessionGeneration={sessionGeneration} captureAccountAction={captureAccountAction} captureSessionGeneration={captureSessionGeneration}
            clients={clients} acquire={acquireProviderCredential} onCreated={() => setRetry(value => value + 1)} />}
        {isAuthenticated && config?.enabled && <section aria-label="Manage child accounts">
            <h2>Your child accounts</h2>
            <p>Choose leaderboard participation separately for each child. Keep the child's password safe. This release has no email recovery for children; you can withdraw consent and delete their account here.</p>
            <button type="button" disabled={busy} onClick={() => setRetry(value => value + 1)}>Refresh child accounts</button>
            {children.length === 0 ? <p>No child accounts are listed.</p> : <>
                <label>Child account<select disabled={busy} value={selected} onChange={event => { selectedNow.current = event.target.value; setSelected(event.target.value); setConfirmation(''); }}>
                    <option value="">Choose the child account</option>{children.map(child => <option key={child.accountId} value={child.accountId}>{child.userName}</option>)}
                </select></label>
                {selected && <ScoreParticipation childAccountId={selected} authenticated={isAuthenticated} accountKey={userName ?? ''} sessionGeneration={sessionGeneration}
                    selectionIsCurrent={() => selectedNow.current === selected} captureAccountAction={captureAccountAction} captureSessionGeneration={captureSessionGeneration} />}
                {selected && import.meta.env.VITE_ENABLE_CHILD_ONLINE_ACTIVITY === '1' && <p><button type="button" disabled={busy} onClick={() => void keepChild()}>Keep this child account active</button></p>}
                <p>Withdrawing consent permanently deletes this child's account and scores and signs out its devices. It cannot be undone.</p>
                <label>Type WITHDRAW AND DELETE<input disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
                <div className="manage-account__actions">
                    {clients.map(client => <button key={client.clientKey} type="button" disabled={busy || !selected || confirmation !== 'WITHDRAW AND DELETE'}
                        onClick={() => void withdraw(client)}>Confirm deletion with {client.provider === 'google' ? 'Google' : 'Apple'}</button>)}
                </div>
            </>}
        </section>}
        {isAuthenticated && config?.enabled && <section aria-label="Delete family accounts">
            <h2>Delete your family accounts</h2>
            <p>This permanently deletes your parent account ({userName}) and every child account listed below, their scores and public entries, and signs out their devices. This cannot be undone.</p>
            {childrenLoaded ? <ul>{children.map(child => <li key={child.accountId}>{child.userName}</li>)}</ul> : <p>Load the current child list before confirming.</p>}
            {childrenLoaded && children.length === 0 && <p>No child accounts are linked. Only your account will be deleted.</p>}
            <label><input type="checkbox" checked={familyAcknowledged} disabled={busy || !childrenLoaded}
                onChange={event => setFamilyAcknowledged(event.target.checked)} />I have checked this list and want to delete all these accounts.</label>
            <label>Type DELETE MY FAMILY<input value={familyConfirmation} disabled={busy || !childrenLoaded}
                onChange={event => setFamilyConfirmation(event.target.value)} /></label>
            <div className="manage-account__actions">
                {clients.map(client => <button type="button" key={client.clientKey}
                    disabled={busy || !childrenLoaded || !familyAcknowledged || familyConfirmation !== 'DELETE MY FAMILY'}
                    onClick={() => void deleteFamily(client)}>Delete family with {client.provider === 'google' ? 'Google' : 'Apple'}</button>)}
            </div>
        </section>}
        {feedback && <p role="status">{feedback}</p>}<p><Link to="/account">Manage your own account</Link></p>
    </div></section>;
}
