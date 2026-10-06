import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { ProviderCredential, ProviderAuthenticationChallenge } from '@/services/authApi';
import type { PublicProviderClient } from '@/services/providerClient';
import { ParentRegistrationError, type ParentRegistrationApi, type ParentConfig, type SignedParentFormRequest } from '@/services/parentRegistrationApi';
import PrivacyNoticeLink from '@/components/PrivacyNoticeLink';
import SignedParentForm from './SignedParentForm';
import notice from '../../../shared/privacyNotice.json' with { type: 'json' };

type Props = {
    api: ParentRegistrationApi;
    authenticated: boolean;
    /** Changes whenever the current account changes; never inferred from provider email. */
    accountKey: string;
    sessionGeneration?: number;
    clients: readonly PublicProviderClient[];
    acquire(client: PublicProviderClient, challenge: ProviderAuthenticationChallenge, signal: AbortSignal): Promise<ProviderCredential>;
    onCreated?(): void;
};

/** Child credentials are collected only after a fresh, consent-bound parent approval. */
export default function ParentRegistration({ api, authenticated, accountKey, sessionGeneration = 0, clients, acquire, onCreated }: Props) {
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
        setFeedback('Your session was refreshed. Restart parent approval. If you submitted child details, refresh the child list first: account creation may still complete.');
    }, [sessionGeneration]);
    useEffect(() => {
        if (!grant) return;
        const timer = setTimeout(() => { discard(); setGrant(null); setPassword(''); setBusy(false);
            setFeedback('The approval window ended. If you submitted child details, check whether the account was created before trying again.'); }, Math.max(0, grant.expiresAt - Date.now()));
        return () => clearTimeout(timer);
    }, [grant]);

    const reset = () => { discard(); setGrant(null); setUserName(''); setPassword(''); setSelectedForm(null); setBusy(false);
        setFeedback('Cancelled. Any unconfirmed account creation must be checked before trying again.'); };
    const errorText = (error: unknown) => error instanceof ParentRegistrationError && error.code === 'VERIFIED_CONTACT_REQUIRED'
        ? 'The provider did not supply a verified email. No child account was created. Try a linked provider that can confirm your email.'
        : error instanceof ParentRegistrationError && error.code === 'SIGNED_FORM_REQUIRED'
        ? 'An approved signed parent form for this exact child, country and notice is required. No child account was created.'
        : error instanceof ParentRegistrationError && error.code === 'PROVIDER_NOT_LINKED'
        ? 'Use the Google or Apple account already linked to your own Ludolume account.'
        : 'This request could not be confirmed. If you submitted child account details, check the account before trying again.';

    const approve = async (client: PublicProviderClient) => {
        if (operation.current || !authenticated || !config?.enabled || !config.countries.includes(country) || !adult || !guardian || !consent) return;
        const needsForm = config.signedFormCountries?.includes(country) === true;
        if (needsForm && (selectedForm ? selectedForm.status !== 'approved' || Date.parse(selectedForm.expiresAt) <= Date.now() : !userName.trim())) return;
        const controller = new AbortController(); operation.current = controller;
        const current = ++generation.current;
        const active = () => current === generation.current && !controller.signal.aborted;
        setBusy(true); setFeedback('');
        try {
            const challenge = await api.begin(config, client.clientKey,
                { country, adultAttestation: true, guardianAttestation: true, consent: true }, controller.signal);
            if (!active()) { void api.cancel(challenge.state).catch(() => undefined); return; }
            challengeState.current = challenge.state;
            const credential = await acquire(client, challenge, controller.signal);
            if (!active()) return;
            if (needsForm && !selectedForm) {
                const form = await api.requestSignedForm(challenge.state, typeof credential === 'string' ? credential : credential.idToken, userName, controller.signal);
                if (!active()) return;
                challengeState.current = null; setSelectedForm(form); setForms(current => [form, ...current]);
                setFeedback('Print and sign the form, then email the scan from the verified parent address shown. The child account is waiting for review and has not been created.');
                return;
            }
            const proof = await api.complete(challenge.state, typeof credential === 'string' ? credential : credential.idToken, controller.signal);
            if (!active()) return;
            if (proof.purpose !== 'create-child') throw new ParentRegistrationError('UNAVAILABLE');
            setGrant({ token: proof.grant, expiresAt: Date.now() + proof.expiresInSeconds * 1000 });
        } catch (error) {
            if (active()) { const state = challengeState.current; challengeState.current = null;
                if (state) void api.cancel(state).catch(() => undefined); setFeedback(errorText(error)); }
        } finally { if (active()) { operation.current = null; setBusy(false); } }
    };
    const create = async (event: FormEvent) => {
        event.preventDefault();
        if (operation.current || !authenticated || !grant || grant.expiresAt <= Date.now()) return;
        const controller = new AbortController(); operation.current = controller;
        const current = ++generation.current;
        setBusy(true); setFeedback('');
        try {
            const child = await api.createChild(grant.token, userName, password, controller.signal, selectedForm?.reference);
            if (current !== generation.current || controller.signal.aborted) return;
            challengeState.current = null; setGrant(null); setUserName(''); setPassword('');
            setFeedback(`Created ${child.userName} with private scores. You are still signed in to your parent account.`);
            setSelectedForm(null); setFormRefresh(value => value + 1);
            onCreated?.();
        } catch (error) { if (current === generation.current && !controller.signal.aborted) {
            discard(); setGrant(null); setPassword(''); setBusy(false); setFeedback(errorText(error));
        } } finally { if (current === generation.current && !controller.signal.aborted) { operation.current = null; setBusy(false); } }
    };
    const selectForm = (form: SignedParentFormRequest) => {
        discard(); setGrant(null); setPassword(''); setBusy(false); setSelectedForm(form); setCountry(form.country); setUserName(form.userName);
        setAdult(false); setGuardian(false); setConsent(false);
        setFeedback(form.status === 'approved' ? 'Signed form approved. Confirm again with the same linked provider, then choose the child password.' : 'This child account has not been created. Return the signed form and wait for review.');
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
            setFeedback('Signed form request cancelled. If you sent a form by email, contact us to request removal of the copy.');
        } catch { if (current === generation.current && !controller.signal.aborted) setFeedback('Cancellation could not be confirmed. Refresh the requests before trying again.'); }
        finally { if (current === generation.current && !controller.signal.aborted) { operation.current = null; setBusy(false); } }
    };

    return <section aria-label="Parent-led registration">
        <h2>Create a private child account</h2>
        <p>Google or Apple confirms your provider account and may confirm your email. Your adult and guardian declarations are separate; provider sign-in does not verify guardianship.</p>
        {config?.enabled && <p><PrivacyNoticeLink url={config.privacyNoticeUrl} /></p>}
        {authenticated && config?.enabled && config.signedFormCountries && <div>
            <button type="button" disabled={busy} onClick={() => setFormRefresh(value => value + 1)}>Refresh signed form requests</button>
            {forms.map(form => <button type="button" key={form.reference} disabled={busy} onClick={() => selectForm(form)}>{form.userName}: {form.status}</button>)}
            {selectedForm && <>
                <SignedParentForm request={selectedForm} policy={config} />
                <button type="button" disabled={busy} onClick={() => void cancelForm()}>Cancel this signed form request</button>
            </>}
        </div>}
        {!authenticated ? <p><Link to="/login">Log in to your own Ludolume account with Google or Apple</Link>, then return here.</p>
            : !config ? <button type="button" onClick={() => setRetry(value => value + 1)}>Retry loading parent registration</button>
            : !config.enabled ? <p>Parent registration is not available on this server.</p>
            : !config.creationEnabled ? <p>New child accounts are paused. Existing child accounts can still be managed below.</p>
            : grant ? <form onSubmit={create}>
                <p>Scores are private. No child email or date of birth is collected. Choose a nickname, not the child's real name.</p>
                <label>Child's nickname<input required maxLength={64} value={userName} disabled={busy || !!selectedForm} onChange={event => setUserName(event.target.value)} /></label>
                <label>Child's password<input type="password" autoComplete="new-password" required minLength={8} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
                <button type="submit" disabled={busy}>Create private child account</button>
            </form> : <div>
                <label>Child's country<select value={country} disabled={busy || !!selectedForm} onChange={event => setCountry(event.target.value)}>
                    <option value="">Choose a country</option>{config.countries.map(value => <option key={value} value={value}>{value}</option>)}
                </select></label>
                {config.signedFormCountries?.includes(country) && <>
                    <p>{notice.signedParentForm.notice}</p>
                    {!selectedForm && <label>Child's chosen nickname<input maxLength={64} value={userName} disabled={busy} onChange={event => setUserName(event.target.value)} /></label>}
                    {selectedForm && selectedForm.status !== 'approved' && <p>Awaiting signed form review. The child account is not active.</p>}
                </>}
                <label><input type="checkbox" checked={adult} disabled={busy} onChange={event => setAdult(event.target.checked)} />I am 18 or older.</label>
                <label><input type="checkbox" checked={guardian} disabled={busy} onChange={event => setGuardian(event.target.checked)} />I am this child's parent or legal guardian and can give this consent.</label>
                <p>{config.consentText}</p>
                <label><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />I agree to this child-account consent.</label>
                {clients.map(client => <button type="button" key={client.clientKey} disabled={busy || !country || !adult || !guardian || !consent
                    || !!config.signedFormCountries?.includes(country) && (selectedForm ? selectedForm.status !== 'approved' : !userName.trim())}
                    onClick={() => void approve(client)}>Confirm with {client.provider === 'google' ? 'Google' : 'Apple'}</button>)}
                {clients.length === 0 && <p>No supported provider is available here. No child details are needed.</p>}
            </div>}
        <button type="button" onClick={reset}>Cancel parent registration</button>
        {feedback && <p role="status">{feedback}</p>}
    </section>;
}
