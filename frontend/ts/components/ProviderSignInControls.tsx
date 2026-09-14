import { useEffect, useId, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { acquireGoogleCredentialInline, acquireProviderCredential, getAvailableProviderClients,
    type PublicProviderClient } from '@/services/providerClient';
import Swal from './siteAlert';

type ProviderAction = 'login' | 'link';
type ProviderSignInControlsProps = {
    action: ProviderAction;
    rememberMe?: boolean;
    disabled?: boolean;
    /** Shared with the surrounding form to guard clicks before React renders disabled controls. */
    operationLock?: { current: boolean };
    onBusyChange?: (busy: boolean) => void;
    onSuccess?: () => void;
};

export function providerSignInErrorMessage(error: string, action: ProviderAction): string | null {
    switch (error) {
        case 'CANCELLED': return null;
        case 'NOT_LINKED': return 'This provider account is not linked yet. Log in with your username and password, then link it in Manage account.';
        case 'INVALID_PASSWORD': return 'That password did not match. Enter your current password and try again.';
        case 'LINK_CONFLICT': return 'This provider account cannot be linked here. It may already be linked to another account.';
        case 'INVALID_CONTEXT': case 'ACCOUNT_GONE': return 'Your session has changed. Log in with your username and password, then try again.';
        case 'INVALID_ATTEMPT': return 'This sign-in attempt expired or was already used. Please start again.';
        case 'INVALID_PROVIDER_TOKEN': return 'The provider could not confirm this sign-in. Please try again.';
        case 'RATE_LIMITED': return 'Too many attempts. Please wait 15 minutes before trying again.';
        case 'BUSY': return 'Sign-in is busy. Please try again in a moment.';
        case 'SESSION_NOT_ESTABLISHED': return 'We could not confirm your login session. Please try logging in again.';
        default: return action === 'link'
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
    const choices = action === 'link' ? clients : clients.filter(client => client.clientKey !== 'google-web');
    if (choices.length === 0) return null;
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
export function InlineGoogleSignIn({ client, rememberMe = false, disabled = false,
    operationLock, onBusyChange, onSuccess }: Omit<ProviderSignInControlsProps, 'action'> & {
        client: PublicProviderClient;
    }) {
    const { prepareProviderLogin, completeProviderLogin, loading, isAuthenticated } = useAuth();
    const host = useRef<HTMLDivElement>(null);
    const latest = useRef({ prepareProviderLogin, completeProviderLogin, rememberMe, disabled,
        isAuthenticated, operationLock, onBusyChange, onSuccess });
    latest.current = { prepareProviderLogin, completeProviderLogin, rememberMe, disabled,
        isAuthenticated, operationLock, onBusyChange, onSuccess };
    const [retry, setRetry] = useState(0);
    const [phase, setPhase] = useState<'preparing' | 'ready' | 'completing' | 'retry'>('preparing');
    const [feedback, setFeedback] = useState<string | null>(null);

    useEffect(() => {
        if (disabled || loading || !host.current || latest.current.isAuthenticated) return;
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
                : providerSignInErrorMessage(code, 'login'));
        };
        setPhase('preparing');
        setFeedback(null);
        void (async () => {
            try {
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
                const result = await latest.current.completeProviderLogin(prepared.handle, idToken,
                    { rememberMe: latest.current.rememberMe, signal: controller.signal });
                if (!active()) return;
                if ('error' in result) { fail(result.error); return; }
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
    }, [client, disabled, loading, retry]);

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

export default function ProviderSignInControls({ action, rememberMe = false, disabled = false,
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

    if (clients.length === 0) return null;
    const inlineGoogle = action === 'login' ? clients.find(client => client.clientKey === 'google-web') : undefined;
    return (
        <div className="provider-sign-in">
            {inlineGoogle && <InlineGoogleSignIn client={inlineGoogle} rememberMe={rememberMe}
                disabled={disabled || busyClient !== null} operationLock={operationLock}
                onBusyChange={onBusyChange} onSuccess={onSuccess} />}
            <ProviderSignInButtons clients={clients} action={action} busyClient={busyClient}
                disabled={disabled} onSelect={client => { void selectProvider(client); }} />
            {feedback && <p className={`provider-sign-in__feedback${feedback.error ? ' provider-sign-in__feedback--error' : ''}`}
                role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
        </div>
    );
}
