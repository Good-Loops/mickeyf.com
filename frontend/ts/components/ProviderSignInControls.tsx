import { useEffect, useId, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { acquireGoogleCredentialInline, acquireProviderCredential, getAvailableProviderClients,
    type PublicProviderClient } from '@/services/providerClient';
import Swal from './siteAlert';
import { requestProviderUsername } from './providerSignupPrompt';
import { PUBLIC_API_PREVIEW } from '@/config/apiConfig';

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

export function providerSignInErrorMessage(error: string, action: ProviderAction | 'delete'): string | null {
    switch (error) {
        case 'CANCELLED': return null;
        case 'NOT_LINKED': return 'New Google accounts are not available on this server yet. Existing password accounts can sign in normally; linking Google in Manage account is optional.';
        case 'ALREADY_LINKED': return 'This Google account already has a Ludolume account. Go to Log in and continue with Google.';
        case 'DUPLICATE_USER': return 'That username or email is already in use. Choose another username, or log in to your existing account to link Google.';
        case 'INVALID_USERNAME': return 'Choose a username with 1–64 characters and no control characters.';
        case 'INVALID_EMAIL': return 'Google could not verify current ownership of this email. Use a Gmail or Google Workspace account, or sign up with a password.';
        case 'ACCOUNT_DELETION_UNAVAILABLE': return 'Google account deletion is not available on this server yet.';
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

/** Linking and native flows still use the provider helper's explicit dialog. */
export function ProviderSignInButtons({ clients, action, busyClient, disabled, onSelect }: {
    clients: readonly PublicProviderClient[];
    action: ProviderAction;
    busyClient: string | null;
    disabled: boolean;
    onSelect: (client: PublicProviderClient) => void;
}) {
    const headingId = useId();
    const choices = action === 'signup' ? [] : action === 'link' ? clients : clients.filter(client => client.clientKey !== 'google-web');
    if (PUBLIC_API_PREVIEW || choices.length === 0) return null;
    return (
        <div className="provider-sign-in__choices" role="group" aria-labelledby={action === 'link' ? headingId : undefined}
            aria-label={action === 'login' ? 'Other sign-in methods' : undefined} aria-busy={busyClient !== null}>
            {action === 'link' && <h2 className="provider-sign-in__heading" id={headingId}>Link a sign-in method</h2>}
            <div className="provider-sign-in__buttons">
                {choices.map(client => (
                    <button className="provider-sign-in__button" type="button" key={client.clientKey}
                        disabled={disabled || busyClient !== null} onClick={() => onSelect(client)}>
                        {busyClient === client.clientKey ? 'Please wait…'
                            : client.provider === 'google' ? 'google' : 'Apple account'}
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

    useEffect(() => {
        if (PUBLIC_API_PREVIEW || disabled || loading || !host.current || latest.current.isAuthenticated) return;
        const element = host.current;
        const controller = new AbortController();
        let current = true;
        let ownsOperation = false;
        let claimedLock: ProviderSignInControlsProps['operationLock'];
        const active = () => current && !controller.signal.aborted;
        const fail = (code: string) => {
            setPhase('retry');
            setFeedback(code === 'CANCELLED'
                ? 'Google sign-in expired or changed. Please try again.'
                : providerSignInErrorMessage(code, action));
        };
        setPhase('preparing');
        setFeedback(null);
        void (async () => {
            try {
                // Login and Sign up are the same Google entry: first identify
                // the account, then ask a username only for a new registration.
                const prepared = await latest.current.prepareProviderLogin(client.clientKey, { signal: controller.signal });
                if (!active()) return;
                if ('error' in prepared) { fail(prepared.error); return; }
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
                let result = await latest.current.completeProviderLogin(prepared.handle, idToken,
                    { rememberMe: latest.current.rememberMe, signal: controller.signal });
                if (!active()) return;
                if ('signupRequired' in result) {
                    const chosenName = await requestProviderUsername(latest.current.userName, controller.signal);
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

    if (PUBLIC_API_PREVIEW || isAuthenticated) return null;
    return (
        <div className="provider-sign-in__google" aria-busy={phase === 'preparing' || phase === 'completing'}>
            <div ref={host} className="provider-sign-in__google-host" role="group" aria-label="Continue with Google"
                inert={disabled || phase !== 'ready'} aria-disabled={disabled || phase !== 'ready'} />
            {!disabled && phase === 'preparing' && <p className="provider-sign-in__feedback" role="status">Loading Google sign-in…</p>}
            {phase === 'completing' && <p className="provider-sign-in__feedback" role="status">Signing in…</p>}
            {phase === 'retry' && <>
                {feedback && <p className="provider-sign-in__feedback provider-sign-in__feedback--error" role="alert">{feedback}</p>}
                <button className="provider-sign-in__button" type="button" disabled={disabled}
                    onClick={() => { if (!latest.current.operationLock?.current) setRetry(value => value + 1); }}>
                    Retry Google sign-in
                </button>
            </>}
        </div>
    );
}

export default function ProviderSignInControls({ action, userName = '', rememberMe = false, disabled = false,
    operationLock, onBusyChange, onSuccess }: ProviderSignInControlsProps) {
    const { authenticateWithProvider } = useAuth();
    const [clients, setClients] = useState<PublicProviderClient[]>([]);
    const [busyClient, setBusyClient] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
    const mounted = useRef(false);
    const operation = useRef<AbortController | null>(null);
    const passwordPopup = useRef<HTMLElement | null>(null);
    const busyCallback = useRef(onBusyChange);
    busyCallback.current = onBusyChange;

    useEffect(() => {
        if (PUBLIC_API_PREVIEW) return;
        mounted.current = true;
        let current = true;
        void getAvailableProviderClients().then(available => {
            if (current) setClients(available);
        }).catch(() => {
            if (current) setClients([]);
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
    }, []);

    const selectProvider = async (client: PublicProviderClient) => {
        if (PUBLIC_API_PREVIEW || action === 'signup') return;
        if (disabled || operation.current || operationLock?.current) return;
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
                    didOpen: popup => { passwordPopup.current = popup; },
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
            const pending = authenticateWithProvider(
                action === 'link' ? { action, clientKey: client.clientKey, password }
                    : { action, clientKey: client.clientKey, rememberMe },
                (challenge, signal) => acquireProviderCredential(client, challenge, signal),
                { signal: controller.signal },
            );
            password = undefined;
            const result = await pending;
            if (!mounted.current || controller.signal.aborted) return;
            if ('error' in result) {
                const text = providerSignInErrorMessage(result.error, action);
                if (text) setFeedback({ text, error: true });
                return;
            }
            if (action === 'link') setFeedback({
                text: `${client.provider === 'google' ? 'Google' : 'Apple'} account linked.`, error: false,
            });
            onSuccess?.();
        } catch {
            if (mounted.current && !controller.signal.aborted) setFeedback({
                text: providerSignInErrorMessage('UNAVAILABLE', action)!, error: true,
            });
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

    if (PUBLIC_API_PREVIEW || clients.length === 0) return null;
    const inlineGoogle = action !== 'link' ? clients.find(client => client.clientKey === 'google-web') : undefined;
    return (
        <div className="provider-sign-in">
            {inlineGoogle && <InlineGoogleSignIn client={inlineGoogle} action={action === 'signup' ? 'signup' : 'login'}
                userName={userName} rememberMe={rememberMe}
                disabled={disabled || busyClient !== null} operationLock={operationLock}
                onBusyChange={onBusyChange} onSuccess={onSuccess} />}
            <ProviderSignInButtons clients={clients} action={action} busyClient={busyClient}
                disabled={disabled} onSelect={client => { void selectProvider(client); }} />
            {feedback && <p className={`provider-sign-in__feedback${feedback.error ? ' provider-sign-in__feedback--error' : ''}`}
                role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
        </div>
    );
}
