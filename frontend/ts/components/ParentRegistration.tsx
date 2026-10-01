import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { ProviderCredential, ProviderAuthenticationChallenge } from '@/services/authApi';
import type { PublicProviderClient } from '@/services/providerClient';
import { ParentRegistrationError, type ParentRegistrationApi, type ParentConfig } from '@/services/parentRegistrationApi';

type Props = {
    api: ParentRegistrationApi;
    authenticated: boolean;
    /** Changes whenever the current account changes; never inferred from provider email. */
    accountKey: string;
    clients: readonly PublicProviderClient[];
    acquire(client: PublicProviderClient, challenge: ProviderAuthenticationChallenge, signal: AbortSignal): Promise<ProviderCredential>;
    onCreated?(): void;
};

/** Child credentials are collected only after a fresh, consent-bound parent approval. */
export default function ParentRegistration({ api, authenticated, accountKey, clients, acquire, onCreated }: Props) {
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
    const operation = useRef<AbortController | null>(null);
    const challengeState = useRef<string | null>(null);
    const generation = useRef(0);

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
        setGrant(null); setPassword(''); setUserName(''); setBusy(false); setFeedback(''); setCountry('');
        setAdult(false); setGuardian(false); setConsent(false);
    }, [api, authenticated, accountKey]);
    useEffect(() => {
        if (!grant) return;
        const timer = setTimeout(() => { discard(); setGrant(null); setPassword(''); setBusy(false);
            setFeedback('The approval window ended. If you submitted child details, check whether the account was created before trying again.'); }, Math.max(0, grant.expiresAt - Date.now()));
        return () => clearTimeout(timer);
    }, [grant]);

    const reset = () => { discard(); setGrant(null); setUserName(''); setPassword(''); setBusy(false);
        setFeedback('Cancelled. Any unconfirmed account creation must be checked before trying again.'); };
    const errorText = (error: unknown) => error instanceof ParentRegistrationError && error.code === 'VERIFIED_CONTACT_REQUIRED'
        ? 'The provider did not supply a verified email. No child account was created. Try a linked provider that can confirm your email.'
        : error instanceof ParentRegistrationError && error.code === 'PROVIDER_NOT_LINKED'
        ? 'Use the Google or Apple account already linked to your own Ludolume account.'
        : 'This request could not be confirmed. If you submitted child account details, check the account before trying again.';

    const approve = async (client: PublicProviderClient) => {
        if (operation.current || !authenticated || !config?.enabled || !config.countries.includes(country) || !adult || !guardian || !consent) return;
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
            const child = await api.createChild(grant.token, userName, password, controller.signal);
            if (current !== generation.current || controller.signal.aborted) return;
            challengeState.current = null; setGrant(null); setUserName(''); setPassword('');
            setFeedback(`Created ${child.userName} with private scores. You are still signed in to your parent account.`);
            onCreated?.();
        } catch (error) { if (current === generation.current && !controller.signal.aborted) {
            discard(); setGrant(null); setPassword(''); setBusy(false); setFeedback(errorText(error));
        } } finally { if (current === generation.current && !controller.signal.aborted) { operation.current = null; setBusy(false); } }
    };

    return <section aria-label="Parent-led registration">
        <h2>Create a private child account</h2>
        <p>Google or Apple confirms your provider account and may confirm your email. Your adult and guardian declarations are separate; provider sign-in does not verify guardianship.</p>
        {!authenticated ? <p><Link to="/login">Log in to your own Ludolume account with Google or Apple</Link>, then return here.</p>
            : !config ? <button type="button" onClick={() => setRetry(value => value + 1)}>Retry loading parent registration</button>
            : !config.enabled ? <p>Parent registration is not available on this server.</p>
            : !config.creationEnabled ? <p>New child accounts are paused. Existing child accounts can still be managed below.</p>
            : grant ? <form onSubmit={create}>
                <p>Scores are private. No child email or date of birth is collected. Choose a nickname, not the child's real name.</p>
                <label>Child's nickname<input required maxLength={64} value={userName} disabled={busy} onChange={event => setUserName(event.target.value)} /></label>
                <label>Child's password<input type="password" autoComplete="new-password" required minLength={8} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
                <button type="submit" disabled={busy}>Create private child account</button>
            </form> : <div>
                <label>Child's country<select value={country} disabled={busy} onChange={event => setCountry(event.target.value)}>
                    <option value="">Choose a country</option>{config.countries.map(value => <option key={value} value={value}>{value}</option>)}
                </select></label>
                <label><input type="checkbox" checked={adult} disabled={busy} onChange={event => setAdult(event.target.checked)} />I am 18 or older.</label>
                <label><input type="checkbox" checked={guardian} disabled={busy} onChange={event => setGuardian(event.target.checked)} />I am this child's parent or legal guardian and can give this consent.</label>
                <p>{config.consentText}</p>
                <label><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />I agree to this child-account consent.</label>
                {clients.map(client => <button type="button" key={client.clientKey} disabled={busy || !country || !adult || !guardian || !consent}
                    onClick={() => void approve(client)}>Confirm with {client.provider === 'google' ? 'Google' : 'Apple'}</button>)}
                {clients.length === 0 && <p>No supported provider is available here. No child details are needed.</p>}
            </div>}
        <button type="button" onClick={reset}>Cancel parent registration</button>
        {feedback && <p role="status">{feedback}</p>}
    </section>;
}
