import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { registrationConfigRequest, beginRegistration, cancelRegistration } from '@/services/authService';
import type { RegistrationAgeBand, RegistrationConfig } from '@/services/registrationApi';

export function ParentRegistrationUnavailable() {
    return <div role="status">
        <h2>A parent or guardian needs to lead this step</h2>
        <p><Link to="/parent-accounts">Continue to parent-led registration</Link> to check availability and sign in to your own parent account.</p>
        <p>No child name, email, password or identity document is needed here. Please do not enter an adult age range for a child.</p>
    </div>;
}

/** Credentials mount only after the server approves this browser's short-lived preflight. */
export default function RegistrationGate({ children }: {
    children: (reset: () => void, scoreVisibility: 'private' | 'public') => ReactNode;
}) {
    const [config, setConfig] = useState<RegistrationConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [retry, setRetry] = useState(0);
    const [country, setCountry] = useState('');
    const [ageBand, setAgeBand] = useState<RegistrationAgeBand | ''>('');
    const [forChild, setForChild] = useState(false);
    const [parentStep, setParentStep] = useState(false);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<string | null>(null);
    const [grant, setGrant] = useState<{ expiresAt: number; visibility: 'private' | 'public' } | null>(null);
    const operation = useRef(false);
    const began = useRef(false);
    const generation = useRef(0);

    useEffect(() => {
        let active = true;
        const controller = new AbortController();
        setLoading(true);
        void registrationConfigRequest(controller.signal).then(value => {
            if (active) { setConfig(value); setLoading(false); }
        });
        return () => { active = false; controller.abort(); };
    }, [retry]);

    useEffect(() => () => {
        generation.current++;
        if (began.current) void cancelRegistration();
    }, []);

    const reset = () => {
        generation.current++;
        setGrant(null); setAgeBand(''); setCountry(''); setParentStep(false); setForChild(false);
        if (began.current) {
            began.current = false;
            // Wait for any in-flight begin before revoking its grant; neither request is abandoned.
            void cancelRegistration();
        }
    };
    useEffect(() => {
        if (!grant) return;
        const timer = setTimeout(() => {
            reset(); setFeedback('This registration step expired. Please choose your country and age range again.');
        }, Math.max(0, grant.expiresAt - Date.now()));
        return () => clearTimeout(timer);
    }, [grant]);

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (operation.current || !config?.enabled || !ageBand || !config.countries.some(item => item.country === country)) return;
        if (forChild || ageBand === 'parent-required') { setParentStep(true); return; }
        operation.current = true; setBusy(true); setFeedback(null); began.current = true;
        const current = ++generation.current;
        const started = Date.now();
        try {
            const result = await beginRegistration({ country, ageBand, policyVersion: config.policyVersion });
            if (current !== generation.current) return;
            if ('authorized' in result) {
                const expiresAt = started + result.expiresInSeconds * 1000;
                if (expiresAt > Date.now()) { setGrant({ expiresAt, visibility: result.scoreVisibility }); return; }
            } else if (result.error === 'PARENT_REQUIRED') { setParentStep(true); return; }
            setFeedback('We could not confirm this registration step. Retry, or log in if you already have an account.');
        } finally {
            operation.current = false;
            if (current === generation.current) setBusy(false);
        }
    }

    if (grant) return children(reset, grant.visibility);
    const rule = config?.enabled ? config.countries.find(item => item.country === country) : undefined;
    const countries = config?.enabled ? config.countries : [];
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    return <section className="signup" aria-labelledby="registration-title">
        <div className="signup__form-wrapper">
            <h1 id="registration-title">Create an account</h1>
            {loading ? <p role="status">Checking registration availability…</p>
                : !config?.enabled ? <div role="status">
                    <p>{config ? 'New registrations are currently paused.' : 'Registration availability could not be confirmed.'}</p>
                    <button type="button" onClick={() => setRetry(value => value + 1)}>Check again</button>
                </div>
                : parentStep ? <><ParentRegistrationUnavailable /><button type="button" onClick={reset}>Back to registration</button></>
                : <form className="signup__form" onSubmit={submit} aria-busy={busy}>
                    <p>Choose the account holder’s country and age range before entering any account details. We do not ask for a date of birth.</p>
                    <label className="signup__field" htmlFor="registration-for"><span>Who is this account for?</span>
                        <select id="registration-for" className="signup__input" disabled={busy} value={forChild ? 'child' : 'self'}
                            onChange={event => { setForChild(event.target.value === 'child'); setAgeBand(''); }}>
                            <option value="self">Myself</option><option value="child">My child — I am their parent or guardian</option>
                        </select>
                    </label>
                    <label className="signup__field" htmlFor="registration-country"><span>Country where the account holder lives</span>
                        <select id="registration-country" className="signup__input" required disabled={busy} value={country}
                            onChange={event => { setCountry(event.target.value); setAgeBand(''); setFeedback(null); }}>
                            <option value="">Choose a country</option>
                            {countries.map(item => <option key={item.country} value={item.country}>{names.of(item.country) ?? item.country}</option>)}
                            <option value="unavailable">My country is not listed</option>
                        </select>
                    </label>
                    {country === 'unavailable' && <p role="status">Registration is not available for that country yet. Please do not choose a different country.</p>}
                    {rule && <label className="signup__field" htmlFor="registration-age"><span>Account holder’s age range</span>
                        <select id="registration-age" className="signup__input" required disabled={busy} value={ageBand}
                            onChange={event => setAgeBand(event.target.value as RegistrationAgeBand)}>
                            <option value="">Choose an age range</option>
                            <option value="parent-required">Under {rule.parentRequiredBelow}</option>
                            {rule.parentRequiredBelow < 18 && <option value="minor">{rule.parentRequiredBelow}–17</option>}
                            <option value="adult">18 or older</option>
                        </select>
                    </label>}
                    {ageBand === 'minor' && !forChild && <p>Your account’s scores will be private and will not appear on public leaderboards.</p>}
                    <button className="signup__submit" type="submit" disabled={busy || !rule || !ageBand}>
                        {busy ? 'Checking…' : forChild || ageBand === 'parent-required' ? 'Continue to parent-led registration' : 'Continue'}
                    </button>
                </form>}
            {feedback && <p role="alert">{feedback}</p>}
            <p><Link to="/login">Already have an account? Log in</Link></p>
            <Link to="/">Cancel</Link>
        </div>
    </section>;
}
