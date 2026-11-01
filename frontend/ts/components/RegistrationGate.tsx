import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { registrationConfigRequest, beginRegistration, cancelRegistration, observeRegistration,
    beginNativeAgeCheck, finishNativeAgeCheck } from '@/services/authService';
import { supportsChildAudience, type RegistrationAgeBand, type RegistrationConfig } from '@/services/registrationApi';
import { registrationAge } from '@/services/registrationAge';

export const REGISTRATION_CONFIG_TIMEOUT_MS = 10_000;
export const REGISTRATION_CHECK_TIMEOUT_MS = 10_000;

async function waitForCheck<T>(pending: Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([pending, new Promise<T>(resolve => {
            timer = setTimeout(() => resolve(fallback), REGISTRATION_CHECK_TIMEOUT_MS);
        })]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/** Keep the precise age in this view only; the server receives a coarse band. */
export function classifyRegistrationAge(value: string, parentRequiredBelow: number, adultFrom: number): RegistrationAgeBand | '' {
    if (!/^\d{1,3}$/.test(value)) return '';
    const age = Number(value);
    if (age > 120) return '';
    return age < parentRequiredBelow ? 'parent-required' : age < adultFrom ? 'minor' : 'adult';
}

export function ParentRegistrationUnavailable() {
    return <div className="registration-parent-notice" role="status">
        <h2>A parent or guardian needs to lead this step</h2>
        <p><Link to="/parent-accounts">Continue to parent-led registration</Link> to check availability and sign in to your own parent account.</p>
        <p>No child name, email, password or identity document is needed here. Please do not enter an adult age for a child.</p>
        <p>A parent can use their own device and account for registration. For an incorrect age result, <Link to="/privacy#privacy-children">contact us for help</Link>. You can keep exploring without an account.</p>
    </div>;
}

/** Credentials mount only after the server approves this browser's short-lived preflight. */
export default function RegistrationGate({ children, purpose = 'signup' }: {
    children: (reset: () => void, scoreVisibility: 'private' | 'public') => ReactNode;
    purpose?: 'signup' | 'provider-login';
}) {
    const [config, setConfig] = useState<RegistrationConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [retry, setRetry] = useState(0);
    const [country, setCountry] = useState('');
    const [ageInput, setAgeInput] = useState('');
    const [parentStep, setParentStep] = useState(false);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<string | null>(null);
    const [grant, setGrant] = useState<{ expiresAt: number; visibility: 'private' | 'public' } | null>(null);
    const operation = useRef(false);
    const began = useRef(false);
    const generation = useRef(0);
    const countryPolicy = supportsChildAudience(config) ? config : null;
    const rule = countryPolicy?.countries.find(item => item.country === country);
    const ageBand = rule ? classifyRegistrationAge(ageInput, rule.parentRequiredBelow, rule.adultFrom) : '';
    const creationPaused = purpose === 'signup' && countryPolicy?.creationEnabled === false;
    const signupPaused = purpose === 'signup' && (config?.enabled === false || creationPaused);

    useEffect(() => {
        let active = true;
        const controller = new AbortController();
        setLoading(true);
        const timeout = setTimeout(() => {
            if (active) {
                controller.abort();
                setConfig(null);
                setLoading(false);
            }
        }, REGISTRATION_CONFIG_TIMEOUT_MS);
        void registrationConfigRequest(controller.signal).then(value => {
            if (active && !controller.signal.aborted) { setConfig(value); setLoading(false); }
        }).catch(() => {
            if (active && !controller.signal.aborted) { setConfig(null); setLoading(false); }
        }).finally(() => clearTimeout(timeout));
        return () => { active = false; clearTimeout(timeout); controller.abort(); };
    }, [retry]);

    useEffect(() => () => {
        generation.current++;
        if (began.current) void cancelRegistration();
    }, []);

    const reset = () => {
        generation.current++;
        setGrant(null); setAgeInput(''); setCountry(''); setParentStep(registrationAge.parentRequired());
        if (began.current) {
            began.current = false;
            // Wait for any in-flight begin before revoking its grant; neither request is abandoned.
            void cancelRegistration();
        }
    };
    useEffect(() => {
        if (!grant) return;
        const timer = setTimeout(() => {
            reset(); setFeedback('This registration step expired. Please enter your country and age again.');
        }, Math.max(0, grant.expiresAt - Date.now()));
        return () => clearTimeout(timer);
    }, [grant]);

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (operation.current || creationPaused || !countryPolicy || !rule || !ageBand) return;
        operation.current = true; setBusy(true); setFeedback(null);
        setAgeInput('');
        const current = ++generation.current;
        const started = Date.now();
        try {
            if (purpose === 'provider-login' && ageBand !== 'adult') registrationAge.rememberMinorProvider();
            // Begin both operations immediately so a slow native prompt cannot delay a submitted restriction.
            let nativeAttempt: string | null = null;
            let promptAllowed = true;
            const checkedAge = registrationAge.check(ageBand, rule.parentRequiredBelow, async () => {
                if (!promptAllowed || current !== generation.current) return false;
                nativeAttempt = await beginNativeAgeCheck();
                return nativeAttempt !== null && promptAllowed && current === generation.current;
            }).catch(() => null);
            const observe = (band: 'minor' | 'parent-required') => Promise.resolve()
                .then(() => observeRegistration({ country, ageBand: band, policyVersion: countryPolicy.policyVersion }))
                .catch(() => false);
            const initialObservation = ageBand === 'adult' ? Promise.resolve(true) : observe(ageBand);
            // This continuation stays alive after a timeout or navigation to record a late restrictive result.
            const nativeObservation = checkedAge.then(effective => {
                if (nativeAttempt) return effective ? finishNativeAgeCheck({ attempt: nativeAttempt, country,
                    ageBand: effective, policyVersion: countryPolicy.policyVersion }) : false;
                return effective && effective !== 'adult' && effective !== ageBand ? observe(effective) : true;
            }).catch(() => false);
            const effectiveAge = await waitForCheck(checkedAge, null);
            promptAllowed = false;
            if (current !== generation.current) return;
            if (!effectiveAge) {
                setFeedback('Your device could not confirm an age range. Account creation may remain unavailable for up to 24 hours. You can keep exploring without an account.');
                return;
            }
            const observed = await waitForCheck(Promise.all([initialObservation, nativeObservation])
                .then(([initial, native]) => initial && native), false);
            if (current !== generation.current) return;
            if (!observed) {
                setFeedback('We couldn’t confirm this age check. Account creation may remain unavailable for up to 24 hours. You can continue as a guest.');
                return;
            }
            if (purpose === 'provider-login' && effectiveAge === 'minor') registrationAge.rememberMinorProvider();
            if (purpose === 'provider-login' && effectiveAge !== 'parent-required' && registrationAge.minorProviderRestricted()) {
                setFeedback('Google and Apple sign-in are temporarily unavailable. You can use your existing username and password, or continue as a guest.');
                return;
            }
            if (effectiveAge === 'parent-required') setParentStep(true);
            began.current = true;
            const result = await beginRegistration({ country, ageBand: effectiveAge, policyVersion: countryPolicy.policyVersion });
            if (current !== generation.current) return;
            if (effectiveAge === 'parent-required') return;
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
    const countries = countryPolicy?.countries ?? [];
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    const titleId = purpose === 'signup' ? 'registration-title' : 'provider-eligibility-title';
    return <section className={purpose === 'signup' ? 'signup' : 'provider-eligibility'} aria-labelledby={titleId}>
        <div className={purpose === 'signup' ? 'signup__form-wrapper' : 'provider-eligibility__content'}>
            {purpose === 'signup' ? <h1 id={titleId}>{signupPaused ? 'Sign up' : 'Check eligibility'}</h1> : <h2 id={titleId}>Other sign-in options</h2>}
            {loading ? <p role="status">{purpose === 'signup' ? 'Checking registration availability…' : 'Checking sign-in options…'}</p>
                : signupPaused ? <p role="status">New account creation is temporarily paused. You can still play as a guest or log in to an existing account.</p>
                : !countryPolicy ? <div className={purpose === 'provider-login' ? 'provider-eligibility__message' : undefined} role={purpose === 'signup' ? 'alert' : 'status'}>
                    <p>{purpose === 'signup' ? 'We can’t check sign-up availability right now. Please try again.'
                        : config?.enabled === false ? 'Google and Apple sign-in are currently unavailable.' : 'We couldn’t check other sign-in options right now.'}</p>
                    {purpose === 'provider-login' && <>
                        <p>Use your username and password to log in, or <Link to="/">continue as a guest</Link>.</p>
                        {config?.enabled !== false && <button className="provider-eligibility__retry" type="button" onClick={() => setRetry(value => value + 1)}>Check again</button>}
                    </>}
                </div>
                : parentStep || registrationAge.parentRequired() ? <ParentRegistrationUnavailable />
                : <form className="signup__form" onSubmit={submit} aria-busy={busy}>
                    {purpose === 'provider-login' && <p>Enter your country and age to continue.</p>}
                    <label className="signup__field" htmlFor="registration-country"><span className="signup__label">Country where you live</span>
                        <select id="registration-country" className="signup__input" required disabled={busy} value={country}
                            onChange={event => { setCountry(event.target.value); setAgeInput(''); setFeedback(null); }}>
                            <option value="">Choose a country</option>
                            {countries.map(item => <option key={item.country} value={item.country}>{names.of(item.country) ?? item.country}</option>)}
                            <option value="unavailable">My country is not listed</option>
                        </select>
                    </label>
                    {country === 'unavailable' && <p role="status">Registration is not available for that country yet. Please do not choose a different country.</p>}
                    {rule && <>
                        <label className="signup__field" htmlFor="registration-age"><span className="signup__label">Your age in years</span>
                            <input id="registration-age" className="signup__input" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={3}
                                autoComplete="off" required disabled={busy} value={ageInput}
                                onChange={event => { setAgeInput(event.target.value); setFeedback(null); }} />
                        </label>
                        {ageInput !== '' && !ageBand && <p role="status">Enter your age as a whole number from 0 to 120.</p>}
                    </>}
                    {purpose === 'signup' && <p>New accounts start with private scores.</p>}
                    <button className="signup__submit" type="submit" disabled={busy || !rule || !ageBand}>
                        {busy ? 'Checking…' : 'Continue'}
                    </button>
                </form>}
            {purpose === 'signup' && (loading ? retry > 0 : signupPaused || !countryPolicy) && <button type="button" className="signup__submit"
                aria-disabled={loading} onClick={() => { if (!loading) setRetry(value => value + 1); }}>Check again</button>}
            {feedback && <p role="alert">{feedback}</p>}
            {feedback && purpose === 'provider-login' && registrationAge.minorProviderRestricted()
                && <p>If you entered the wrong age, <Link to="/privacy#privacy-children">contact us for help</Link>.</p>}
            {purpose === 'signup' && <p className="signup__account-link"><Link to="/">Continue as a guest</Link> · <Link to="/login">Log in</Link></p>}
        </div>
    </section>;
}
