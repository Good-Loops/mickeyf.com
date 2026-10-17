import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { acquireGoogleCredentialInline, acquireProviderCredential, getAvailableProviderClients, preloadProviderCredential,
    type PublicProviderClient } from '@/services/providerClient';
import Swal from './siteAlert';
import { requestProviderUsername } from './providerSignupPrompt';
import { LEGACY_PUBLIC_API_PREVIEW } from '@/config/apiConfig';

type ProviderAction = 'login' | 'link' | 'signup';
type ProviderSignInControlsProps = {
    action: ProviderAction;
    rememberMe?: boolean;
    userName?: string;
    disabled?: boolean;
    /** Shared with the surrounding form to guard clicks before React renders disabled controls. */
    operationLock?: { current: boolean };
    onBusyChange?: (busy: boolean) => void;
    onSuccess?: () => void;
};

export function providerSignInErrorMessage(error: string, action: ProviderAction | 'delete',
    provider: 'google' | 'apple' = 'google'): string | null {
    const providerName = provider === 'apple' ? 'Apple' : 'Google';
    switch (error) {
        case 'CANCELLED': return null;
        case 'REGISTRATION_REQUIRED': return action === 'login' ? `This ${providerName} account isn’t linked yet.` : 'Signup is temporarily unavailable. Please try again.';
        case 'NOT_LINKED': return `This ${providerName} account isn’t linked yet.`;
        case 'ALREADY_LINKED': return `This ${providerName} account already has a Ludolume account. Go to Log in and continue with ${providerName}.`;
        case 'DUPLICATE_USER': return `That username or email is already in use. Choose another username, or log in to your existing account to link ${providerName}.`;
        case 'INVALID_USERNAME': return 'Choose a username with 1–64 characters and no control characters.';
        case 'INVALID_EMAIL': return provider === 'apple'
            ? 'Apple did not provide a verified email for this signup. Try again, or sign up with a password.'
            : 'Google could not verify current ownership of this email. Use a Gmail or Google Workspace account, or sign up with a password.';
        case 'ACCOUNT_DELETION_UNAVAILABLE': return `${providerName} account deletion is not available on this server yet.`;
        case 'ACCOUNT_DELETION_PENDING': return 'Your deletion request was recorded, but completion has not been confirmed. Retrying will not cancel it. Contact mickeyf.plays@gmail.com if it remains pending.';
        case 'INVALID_PASSWORD': return 'That password did not match. Enter your current password and try again.';
        case 'LINK_CONFLICT': return 'This provider account cannot be linked here. It may already be linked to another account.';
        case 'INVALID_CONTEXT': case 'ACCOUNT_GONE': return 'Your session has changed. Log in again, then try again.';
        case 'INVALID_ATTEMPT': return 'This sign-in attempt expired or was already used. Please start again.';
        case 'INVALID_PROVIDER_TOKEN': return 'The provider could not confirm this sign-in. Please try again.';
        case 'RATE_LIMITED': return 'Too many attempts. Please wait 15 minutes before trying again.';
        case 'BUSY': return 'Sign-in is busy. Please try again in a moment.';
        case 'SESSION_NOT_ESTABLISHED': return 'We could not confirm your login session. Please try logging in again.';
        default: return action === 'delete'
            ? 'We could not confirm account deletion. A request may already be recorded; retrying later will not cancel it.'
            : action === 'link'
            ? 'We could not confirm the link. Check your connection and try again.'
            : 'We could not confirm sign-in. Check your connection and try again.';
    }
}

function shouldShowProviderChoice(client: PublicProviderClient, action: ProviderAction): boolean {
    if (action === 'signup' && client.platform === 'web') {
        // Active Google signup uses GIS inline; unavailable signup remains an explicit availability action.
        return client.clientKey !== 'google-web' || client.signup !== true || client.issuance === false;
    }
    if (client.issuance === false) return false;
    if (action === 'link') return true;
    return client.clientKey !== 'google-web' && (action !== 'signup' || client.signup === true);
}

function providerButtonLabel(provider: 'google' | 'apple') {
    return provider === 'google' ? <>
        <span className="provider-sign-in__google-mark" aria-hidden="true">
            <img src="/images/google-sign-in-logo.svg" alt="" width="18" height="18" />
        </span><span>Continue with Google</span>
    </> : <>
        <img src="/images/apple-sign-in-logo-white.png" alt="" aria-hidden="true" width="42" height="42" />
        <span>Continue with Apple</span>
    </>;
}

function pendingProviderButton(provider: 'google' | 'apple') {
    return <button key={provider} className={`provider-sign-in__button provider-sign-in__button--placeholder${provider === 'apple' ? ' provider-sign-in__button--apple' : ''}`}
        type="button" disabled aria-label={`Continue with ${provider === 'google' ? 'Google' : 'Apple'}`}>
        {providerButtonLabel(provider)}
    </button>;
}

/** Active Google web uses its official control; closed signup choices explain availability. */
export function ProviderSignInButtons({ clients, action, busyClient, disabled, onSelect }: {
    clients: readonly PublicProviderClient[];
    action: ProviderAction;
    busyClient: string | null;
    disabled: boolean;
    onSelect: (client: PublicProviderClient) => void;
}) {
    const headingId = useId();
    const choices = clients.filter(client => shouldShowProviderChoice(client, action));
    if (LEGACY_PUBLIC_API_PREVIEW || choices.length === 0) return null;
    return (
        <div className="provider-sign-in__choices" role="group" aria-labelledby={action === 'link' ? headingId : undefined}
            aria-label={action !== 'link' ? 'Other sign-in methods' : undefined} aria-busy={busyClient !== null}>
            {action === 'link' && <h2 className="provider-sign-in__heading" id={headingId}>Link a sign-in method</h2>}
            <div className="provider-sign-in__buttons">
                {choices.map(client => (
                    <button className={`provider-sign-in__button${client.provider === 'google' && client.platform !== 'web' ? ' provider-sign-in__button--native-google' : ''}${client.provider === 'apple' && action !== 'link' ? ' provider-sign-in__button--apple' : ''}${client.clientKey === 'google-web' && action === 'signup' ? ' provider-sign-in__button--availability' : ''}`}
                        type="button" key={client.clientKey}
                        disabled={disabled || busyClient !== null} onClick={() => onSelect(client)}>
                        {busyClient === client.clientKey ? 'Please wait…'
                            : client.provider === 'google' ? (client.platform === 'web' ? action === 'signup' ? providerButtonLabel('google') : 'google'
                                : <img src={`/images/google-sign-in-${client.platform}.png`} alt="Sign in with Google"
                                    height="44" width={client.platform === 'ios' ? 188 : 198} />)
                                : action === 'link' ? 'Apple account' : providerButtonLabel('apple')}
                    </button>
                ))}
            </div>
        </div>
    );
}

/** Preparation does not lock the password form; only a returned credential claims it. */
export function InlineGoogleSignIn({ client, action = 'login', userName = '', rememberMe = false, disabled = false,
    operationLock, onBusyChange, onSuccess }: Omit<ProviderSignInControlsProps, 'action'> & {
        client: PublicProviderClient;
        action?: 'login' | 'signup';
    }) {
    const { prepareProviderLogin, completeProviderLogin, loading, isAuthenticated } = useAuth();
    const host = useRef<HTMLDivElement>(null);
    const latest = useRef({ prepareProviderLogin, completeProviderLogin, userName, rememberMe, disabled,
        isAuthenticated, operationLock, onBusyChange, onSuccess });
    latest.current = { prepareProviderLogin, completeProviderLogin, userName, rememberMe, disabled,
        isAuthenticated, operationLock, onBusyChange, onSuccess };
    const [retry, setRetry] = useState(0);
    const [phase, setPhase] = useState<'preparing' | 'ready' | 'completing' | 'retry'>('preparing');
    const [feedback, setFeedback] = useState<string | null>(null);
    const [needsAccount, setNeedsAccount] = useState(false);
    const previouslyAuthenticated = useRef(isAuthenticated);

    useEffect(() => {
        // Sign-out recreates the widget host. Sign-in must not cancel the completion that caused it.
        if (previouslyAuthenticated.current && !isAuthenticated) setRetry(value => value + 1);
        previouslyAuthenticated.current = isAuthenticated;
    }, [isAuthenticated]);

    useEffect(() => {
        if (LEGACY_PUBLIC_API_PREVIEW || client.issuance === false || disabled || loading || !host.current || latest.current.isAuthenticated) return;
        const element = host.current;
        const controller = new AbortController();
        let current = true;
        let ownsOperation = false;
        let claimedLock: ProviderSignInControlsProps['operationLock'];
        const active = () => current && !controller.signal.aborted;
        const fail = (code: string) => {
            setPhase('retry');
            setNeedsAccount(action === 'login' && ['REGISTRATION_REQUIRED', 'NOT_LINKED'].includes(code));
            setFeedback(code === 'CANCELLED'
                ? 'Google sign-in expired or changed. Please try again.'
                : providerSignInErrorMessage(code, action));
        };
        setPhase('preparing');
        setFeedback(null);
        setNeedsAccount(false);
        void (async () => {
            try {
                // Public SDK loading can overlap the serialized anonymous grant/challenge requests.
                // Catch immediately so a slow server response never leaves a rejected preload unhandled.
                const sdkReady = preloadProviderCredential(client, controller.signal).then(() => true, () => false);
                // Signup preserves the registration preflight cookie; ordinary login retains its existing flow.
                const prepared = await latest.current.prepareProviderLogin(client.clientKey, { signal: controller.signal }, action);
                if (!active()) return;
                if ('error' in prepared) { fail(prepared.error); return; }
                if (!await sdkReady) { if (active()) fail('UNAVAILABLE'); return; }
                const idToken = await acquireGoogleCredentialInline(client, prepared.challenge, element,
                    controller.signal, () => { if (active()) setPhase('ready'); });
                if (!active()) return;
                if (latest.current.disabled || latest.current.isAuthenticated || latest.current.operationLock?.current) {
                    fail('CANCELLED');
                    return;
                }
                claimedLock = latest.current.operationLock;
                if (claimedLock) claimedLock.current = true;
                ownsOperation = true;
                setPhase('completing');
                latest.current.onBusyChange?.(true);
                const signupName = action === 'signup'
                    ? await requestProviderUsername(latest.current.userName, controller.signal, client.provider) : undefined;
                if (!active()) return;
                if (signupName === null) { fail('CANCELLED'); controller.abort(); return; }
                let result = await latest.current.completeProviderLogin(prepared.handle, idToken,
                    { rememberMe: latest.current.rememberMe, signal: controller.signal,
                        ...(signupName === undefined ? {} : { userName: signupName }) });
                if (!active()) return;
                if ('signupRequired' in result) {
                    const chosenName = await requestProviderUsername(latest.current.userName, controller.signal, client.provider);
                    if (!active()) return;
                    if (chosenName === null) { fail('CANCELLED'); controller.abort(); return; }
                    result = await latest.current.completeProviderLogin(result.handle, idToken,
                        { rememberMe: latest.current.rememberMe, signal: controller.signal, userName: chosenName });
                }
                if (!active()) return;
                if ('error' in result) { fail(result.error); return; }
                if (!('user_name' in result)) { fail('UNAVAILABLE'); return; }
                latest.current.onSuccess?.();
            } catch (error) {
                if (active()) fail(error && typeof error === 'object' && 'code' in error && error.code === 'CANCELLED'
                    ? 'CANCELLED' : 'UNAVAILABLE');
            } finally {
                if (ownsOperation) {
                    if (claimedLock) claimedLock.current = false;
                    latest.current.onBusyChange?.(false);
                }
            }
        })();
        return () => {
            current = false;
            controller.abort();
        };
        // Callback identities, typing and remember-me changes must not create new attempts.
    }, [client, action, disabled, loading, retry]);

    if (LEGACY_PUBLIC_API_PREVIEW || client.issuance === false || isAuthenticated) return null;
    return (
        <div className="provider-sign-in__google" aria-busy={phase === 'preparing' || phase === 'completing'}>
            {phase !== 'retry' && <div ref={host} className="provider-sign-in__google-host" role="group" aria-label="Continue with Google"
                hidden={phase !== 'ready'}
                inert={disabled || phase !== 'ready'} aria-disabled={disabled || phase !== 'ready'} />}
            {(phase === 'preparing' || phase === 'completing') && pendingProviderButton('google')}
            {phase === 'preparing' && <span className="u-visually-hidden" role="status">Preparing Google sign-in</span>}
            {phase === 'completing' && <span className="u-visually-hidden" role="status">Signing in</span>}
            {phase === 'retry' && <div className="provider-sign-in__retry">
                {feedback && <p className="provider-sign-in__feedback provider-sign-in__feedback--error" role="alert">{feedback}</p>}
                {needsAccount && <Link className="provider-sign-in__account-action" to="/signup">Create account</Link>}
                <button className="provider-sign-in__button" type="button" disabled={disabled}
                    onClick={() => {
                        if (latest.current.operationLock?.current) return;
                        setPhase('preparing');
                        setRetry(value => value + 1);
                    }}>
                    Retry Google sign-in
                </button>
            </div>}
        </div>
    );
}

export default function ProviderSignInControls({ action, userName = '', rememberMe = false, disabled = false,
    operationLock, onBusyChange, onSuccess }: ProviderSignInControlsProps) {
    const { authenticateWithProvider, prepareProviderLogin, completeProviderLogin } = useAuth();
    const [clients, setClients] = useState<PublicProviderClient[]>([]);
    const [configurationLoading, setConfigurationLoading] = useState(true);
    const [configurationRetry, setConfigurationRetry] = useState(0);
    const [busyClient, setBusyClient] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<{ text: string; error: boolean; needsAccount?: boolean } | null>(null);
    const mounted = useRef(false);
    const operation = useRef<AbortController | null>(null);
    const passwordPopup = useRef<HTMLElement | null>(null);
    const busyCallback = useRef(onBusyChange);
    busyCallback.current = onBusyChange;

    useEffect(() => {
        if (LEGACY_PUBLIC_API_PREVIEW) return;
        mounted.current = true;
        let current = true;
        setConfigurationLoading(true);
        void getAvailableProviderClients(available => {
            if (current) setClients(available);
        }).then(available => {
            if (current) { setClients(available); setConfigurationLoading(false); }
        }).catch(() => {
            if (current) { setClients([]); setConfigurationLoading(false); }
        });
        return () => {
            current = false;
            mounted.current = false;
            const pending = operation.current;
            operation.current = null;
            pending?.abort();
            if (passwordPopup.current && Swal.getPopup() === passwordPopup.current) Swal.close();
            if (pending) {
                if (operationLock) operationLock.current = false;
                busyCallback.current?.(false);
            }
        };
    }, [configurationRetry]);

    const selectProvider = async (client: PublicProviderClient) => {
        if (LEGACY_PUBLIC_API_PREVIEW) return;
        if (disabled || operation.current || operationLock?.current) return;
        if (action === 'signup' && (client.issuance === false || client.signup !== true)) {
            setFeedback({ text: `Account creation with ${client.provider === 'google' ? 'Google' : 'Apple'} is temporarily unavailable. Please try again later.`, error: true });
            return;
        }
        if (client.issuance === false) return;
        if (operationLock) operationLock.current = true;
        const controller = new AbortController();
        operation.current = controller;
        setBusyClient(client.clientKey);
        setFeedback(null);
        busyCallback.current?.(true);
        let password: string | undefined;
        try {
            if (action === 'link') {
                let confirmPromptClosed!: () => void;
                const promptClosed = new Promise<void>(resolve => { confirmPromptClosed = resolve; });
                const decision = await Swal.fire<string>({
                    title: 'Confirm your current password',
                    text: 'Link this sign-in method to the account you are using now.',
                    input: 'password',
                    inputLabel: 'Current password',
                    inputAttributes: { autocomplete: 'current-password', autocapitalize: 'off' },
                    inputValidator: value => value ? undefined : 'Enter your current password.',
                    showCancelButton: true,
                    confirmButtonText: 'Continue',
                    cancelButtonText: 'Cancel',
                    didOpen: popup => {
                        passwordPopup.current = popup;
                        if (controller.signal.aborted && Swal.getPopup() === popup) Swal.close();
                    },
                    didDestroy: confirmPromptClosed,
                });
                // fire() resolves before the closing animation finishes; the provider needs a free dialog.
                await promptClosed;
                passwordPopup.current = null;
                if (!decision.isConfirmed || controller.signal.aborted) return;
                password = decision.value;
                if (!password) return;
            }
            if (controller.signal.aborted) return;
            let result;
            if (action === 'link') {
                const pending = authenticateWithProvider({ action, clientKey: client.clientKey, password },
                    (challenge, signal) => acquireProviderCredential(client, challenge, signal),
                    { signal: controller.signal });
                password = undefined;
                result = await pending;
            } else {
                // Explicit signup keeps its reviewed age/country grant; login remains available without preflight.
                const prepared = await prepareProviderLogin(client.clientKey, { signal: controller.signal }, action);
                if (!mounted.current || controller.signal.aborted) return;
                if ('error' in prepared) result = prepared;
                else {
                    const credential = await acquireProviderCredential(client, prepared.challenge, controller.signal);
                    if (!mounted.current || controller.signal.aborted) return;
                    const signupName = action === 'signup'
                        ? await requestProviderUsername(userName, controller.signal, client.provider) : undefined;
                    if (!mounted.current || controller.signal.aborted) return;
                    if (signupName === null) { controller.abort(); return; }
                    result = await completeProviderLogin(prepared.handle, credential, { rememberMe, signal: controller.signal,
                        ...(signupName === undefined ? {} : { userName: signupName }) });
                    if (!mounted.current || controller.signal.aborted) return;
                    if ('signupRequired' in result) {
                        const chosenName = await requestProviderUsername(userName, controller.signal, client.provider);
                        if (!mounted.current || controller.signal.aborted) return;
                        if (chosenName === null) { controller.abort(); return; }
                        result = await completeProviderLogin(result.handle, credential,
                            { rememberMe, signal: controller.signal, userName: chosenName });
                    }
                }
            }
            if (!mounted.current || controller.signal.aborted) return;
            if ('error' in result) {
                const text = providerSignInErrorMessage(result.error, action, client.provider);
                if (text) setFeedback({ text, error: true,
                    needsAccount: action === 'login' && ['REGISTRATION_REQUIRED', 'NOT_LINKED'].includes(result.error) });
                return;
            }
            if (action === 'link' ? !('linked' in result) : !('user_name' in result)) {
                setFeedback({ text: providerSignInErrorMessage('UNAVAILABLE', action, client.provider)!, error: true });
                return;
            }
            if (action === 'link') setFeedback({
                text: `${client.provider === 'google' ? 'Google' : 'Apple'} account linked.`, error: false,
            });
            onSuccess?.();
        } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error && error.code === 'CANCELLED'
                ? 'CANCELLED' : 'UNAVAILABLE';
            const text = providerSignInErrorMessage(code, action, client.provider);
            if (mounted.current && !controller.signal.aborted && text) setFeedback({ text, error: true });
        } finally {
            password = undefined;
            if (operation.current === controller) {
                operation.current = null;
                if (operationLock) operationLock.current = false;
                if (mounted.current) {
                    setBusyClient(null);
                    busyCallback.current?.(false);
                }
            }
        }
    };

    if (LEGACY_PUBLIC_API_PREVIEW) return null;
    if (configurationLoading && clients.length === 0 && action !== 'link') return <div className="provider-sign-in" aria-busy="true">
        <span className="u-visually-hidden" role="status">Checking sign-in methods</span>
        {pendingProviderButton('google')}{pendingProviderButton('apple')}
    </div>;
    if (clients.length === 0) return null;
    const inlineGoogle = action !== 'link' ? clients.find(client => client.clientKey === 'google-web'
        && client.issuance !== false && (action !== 'signup' || client.signup === true)) : undefined;
    const unavailableApple = !configurationLoading && clients.some(client => client.provider === 'apple' && client.issuance === false);
    return (
        <div className="provider-sign-in">
            {inlineGoogle && <InlineGoogleSignIn client={inlineGoogle} action={action === 'signup' ? 'signup' : 'login'}
                userName={userName} rememberMe={rememberMe}
                disabled={disabled || busyClient !== null} operationLock={operationLock}
                onBusyChange={onBusyChange} onSuccess={onSuccess} />}
            <ProviderSignInButtons clients={clients} action={action} busyClient={busyClient}
                disabled={disabled} onSelect={client => { void selectProvider(client); }} />
            {configurationLoading && action !== 'link' && <>
                <span className="u-visually-hidden" role="status">Checking Apple sign-in availability</span>
                {pendingProviderButton('apple')}
            </>}
            {unavailableApple && <div role="status">
                <p>Apple sign-in is temporarily unavailable.</p>
                <button className="provider-sign-in__button" type="button" disabled={disabled || busyClient !== null || operationLock?.current === true}
                    onClick={() => { if (!operationLock?.current && busyClient === null) setConfigurationRetry(value => value + 1); }}>Check again</button>
            </div>}
            {feedback && <p className={`provider-sign-in__feedback${feedback.error ? ' provider-sign-in__feedback--error' : ''}`}
                role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
            {feedback?.needsAccount && <Link className="provider-sign-in__account-action" to="/signup">Create account</Link>}
        </div>
    );
}
