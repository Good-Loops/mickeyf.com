import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import ScoreParticipation from '@/components/ScoreParticipation';
import ParentRegistration from '@/components/ParentRegistration';
import ParentInactivityWarning from '@/components/ParentInactivityWarning';
import ParentDailyUsage from '@/components/ParentDailyUsage';
import { createParentRegistrationApi, type ParentConfig } from '@/services/parentRegistrationApi';
import { acquireProviderCredential, getAvailableProviderClients, type PublicProviderClient } from '@/services/providerClient';
import { apiFetch } from '@/services/apiFetch';
import { API_BASE, LEGACY_PUBLIC_API_PREVIEW } from '@/config/apiConfig';
import { isChildLifecycleEnabled } from '@/config/childLifecycleGate';
import { providerAccountMethodsRequest } from '@/services/authService';
import { capturePageOwnership, sameAccountIds } from '@/services/pageOwnership';
import type { PageRequestInit } from '@/services/pageOwnership';
import { parentAccountText, type ParentFeedback, type ParentLanguage } from '@/components/parentAccountText';

const api = createParentRegistrationApi(API_BASE, apiFetch, { requireChildAudience: true });
export default function ParentAccounts() {
    const [language, setLanguage] = useState<ParentLanguage>('en');
    const text = parentAccountText[language];
    const childLifecycleEnabled = isChildLifecycleEnabled(import.meta.env.VITE_ENABLE_CHILD_ONLINE_ACTIVITY, import.meta.env.VITE_ENABLE_CHILD_INACTIVITY_WARNING);
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
    const [feedback, setFeedback] = useState<ParentFeedback | ''>('');
    const [busy, setBusy] = useState(false);
    const [warningRevision, setWarningRevision] = useState(0);
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
            setFeedback('sessionRefreshed');
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
            }).catch(() => { if (!controller.signal.aborted) setFeedback('loadFailed'); });
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
            if (!controller.signal.aborted && isCurrent()) { setFeedback('kept'); setWarningRevision(value => value + 1); }
        } catch { if (!controller.signal.aborted && isCurrent()) setFeedback('keepFailed'); }
        finally { if (operation.current === controller) { operation.current = null; if (!controller.signal.aborted) setBusy(false); } }
    }
    async function withdraw(client: PublicProviderClient) {
        if (operation.current || !isAuthenticated || !config?.enabled || confirmation !== text.withdrawPhrase
            || !children.some(child => child.accountId === selected)) return;
        const controller = new AbortController(); const ownsPage = capturePageOwnership();
        const target = selected, account = userName, generation = sessionGeneration, expectedAction = captureAccountAction();
        const isOwner = () => ownsPage() && latest.current.isAuthenticated && !latest.current.loading
            && latest.current.userName === account && latest.current.sessionGeneration === generation && captureSessionGeneration() === generation
            && captureAccountAction() === expectedAction;
        const isCurrent = () => isOwner()
            && latest.current.selected === target && latest.current.confirmation === text.withdrawPhrase
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
            pendingState.current = null; setFeedback('withdrawn');
            setRetry(value => value + 1);
        } catch { if (active()) setFeedback('withdrawalUnconfirmed'); }
        finally { if (operation.current === controller) { const state = pendingState.current; pendingState.current = null;
            if (state) void api.cancel(state).catch(() => undefined); operation.current = null; if (!controller.signal.aborted) setBusy(false); } }
    }
    async function deleteFamily(client: PublicProviderClient) {
        if (operation.current || !isAuthenticated || !config?.enabled || !childrenLoaded
            || !familyAcknowledged || familyConfirmation !== text.familyPhrase) return;
        const ids = children.map(child => child.accountId);
        const controller = new AbortController(); const ownsPage = capturePageOwnership();
        const account = userName, generation = sessionGeneration, expectedAction = captureAccountAction();
        const isOwner = () => ownsPage() && latest.current.isAuthenticated && !latest.current.loading
            && latest.current.userName === account && latest.current.sessionGeneration === generation && captureSessionGeneration() === generation;
        const isPageCurrent = () => isOwner()
            && latest.current.childrenLoaded && latest.current.familyAcknowledged && latest.current.familyConfirmation === text.familyPhrase
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
        } catch { if (canUpdate()) setFeedback('familyUnconfirmed'); }
        finally { if (operation.current === controller) { const state = pendingState.current; pendingState.current = null;
            if (state) void api.cancel(state).catch(() => undefined); operation.current = null; if (!controller.signal.aborted) setBusy(false); } }
    }
    function chooseLanguage(value: ParentLanguage) {
        if (busy || value === language) return;
        setLanguage(value); setConfirmation(''); setFamilyConfirmation(''); setFamilyAcknowledged(false);
    }
    if (LEGACY_PUBLIC_API_PREVIEW) return <p lang={language}>{text.preview}</p>;
    return <section className="manage-account parent-accounts" lang={language}><div className="manage-account__form-wrapper">
        <div role="group" aria-label="Language / Idioma">
            <button type="button" lang="en" aria-pressed={language === 'en'} disabled={busy} onClick={() => chooseLanguage('en')}>English</button>{' '}
            <button type="button" lang="pt-BR" aria-pressed={language === 'pt-BR'} disabled={busy} onClick={() => chooseLanguage('pt-BR')}>Português</button>
        </div>
        <h1 className="manage-account__title">{text.title}</h1>
        {loading ? <p>{text.checking}</p> : <ParentRegistration api={api} authenticated={isAuthenticated} language={language}
            requireChildAudience
            accountKey={userName ?? ''} sessionGeneration={sessionGeneration} captureAccountAction={captureAccountAction} captureSessionGeneration={captureSessionGeneration}
            clients={clients} acquire={acquireProviderCredential} onCreated={() => setRetry(value => value + 1)} />}
        {isAuthenticated && config?.enabled && <section aria-label={text.manage}>
            <h2>{text.children}</h2>
            <p>{text.guidance}</p>
            <button type="button" disabled={busy} onClick={() => setRetry(value => value + 1)}>{text.refresh}</button>
            {children.length === 0 ? <p>{text.empty}</p> : <>
                <label>{text.child}<select disabled={busy} value={selected} onChange={event => { selectedNow.current = event.target.value; setSelected(event.target.value); setConfirmation(''); }}>
                    <option value="">{text.choose}</option>{children.map(child => <option key={child.accountId} value={child.accountId}>{child.userName}</option>)}
                </select></label>
                {selected && <ScoreParticipation language={language} childAccountId={selected} authenticated={isAuthenticated} accountKey={userName ?? ''} sessionGeneration={sessionGeneration}
                    selectionIsCurrent={() => selectedNow.current === selected} captureAccountAction={captureAccountAction} captureSessionGeneration={captureSessionGeneration} />}
                {selected && import.meta.env.VITE_ENABLE_CHILD_DAILY_USAGE === '1' && <ParentDailyUsage language={language}
                    key={`${sessionGeneration}:${selected}`} childAccountId={selected} sessionGeneration={sessionGeneration}
                    selectionIsCurrent={() => selectedNow.current === selected} captureAccountAction={captureAccountAction} captureSessionGeneration={captureSessionGeneration} />}
                {selected && childLifecycleEnabled && <ParentInactivityWarning language={language}
                    key={`${sessionGeneration}:${selected}`} childAccountId={selected} sessionGeneration={sessionGeneration} refreshKey={warningRevision}
                    selectionIsCurrent={() => selectedNow.current === selected} captureAccountAction={captureAccountAction} captureSessionGeneration={captureSessionGeneration} />}
                {selected && childLifecycleEnabled && <p><button type="button" disabled={busy} onClick={() => void keepChild()}>{text.keep}</button></p>}
                <p>{text.withdrawal}</p>
                <label>{text.type} {text.withdrawPhrase}<input name="withdraw-confirmation" disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
                <div className="manage-account__actions">
                    {clients.map(client => <button key={client.clientKey} type="button" disabled={busy || !selected || confirmation !== text.withdrawPhrase}
                        onClick={() => void withdraw(client)}>{text.confirmDeletion} {client.provider === 'google' ? 'Google' : 'Apple'}</button>)}
                </div>
            </>}
        </section>}
        {isAuthenticated && config?.enabled && <section aria-label={text.deleteFamily}>
            <h2>{text.familyTitle}</h2>
            <p>{text.familyBeforeName} ({userName}) {text.familyAfterName}</p>
            {childrenLoaded ? <ul>{children.map(child => <li key={child.accountId}>{child.userName}</li>)}</ul> : <p>{text.loadList}</p>}
            {childrenLoaded && children.length === 0 && <p>{text.noLinkedChildren}</p>}
            <label><input type="checkbox" checked={familyAcknowledged} disabled={busy || !childrenLoaded}
                onChange={event => setFamilyAcknowledged(event.target.checked)} />{text.acknowledgeFamily}</label>
            <label>{text.type} {text.familyPhrase}<input name="family-confirmation" value={familyConfirmation} disabled={busy || !childrenLoaded}
                onChange={event => setFamilyConfirmation(event.target.value)} /></label>
            <div className="manage-account__actions">
                {clients.map(client => <button type="button" key={client.clientKey}
                    disabled={busy || !childrenLoaded || !familyAcknowledged || familyConfirmation !== text.familyPhrase}
                    onClick={() => void deleteFamily(client)}>{text.deleteFamilyWith} {client.provider === 'google' ? 'Google' : 'Apple'}</button>)}
            </div>
        </section>}
        {feedback && <p role="status">{text[feedback]}</p>}<p><Link to="/account">{text.ownAccount}</Link></p>
    </div></section>;
}
