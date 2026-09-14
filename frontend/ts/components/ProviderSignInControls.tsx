import { useEffect, useId, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { acquireProviderCredential, getAvailableProviderClients, type PublicProviderClient } from '@/services/providerClient';
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

/** Neutral account selectors; the SDK/helper presents the provider's own sign-in controls. */
export function ProviderSignInButtons({ clients, action, busyClient, disabled, onSelect }: {
    clients: readonly PublicProviderClient[];
    action: ProviderAction;
    busyClient: string | null;
    disabled: boolean;
    onSelect: (client: PublicProviderClient) => void;
}) {
    const headingId = useId();
    if (clients.length === 0) return null;
    return (
        <div className="provider-sign-in__choices" role="group" aria-labelledby={headingId} aria-busy={busyClient !== null}>
            <h2 className="provider-sign-in__heading" id={headingId}>
                {action === 'link' ? 'Link a sign-in method' : 'Or use a linked account'}
            </h2>
            <div className="provider-sign-in__buttons">
                {clients.map(client => (
                    <button className="provider-sign-in__button" type="button" key={client.clientKey}
                        disabled={disabled || busyClient !== null} onClick={() => onSelect(client)}>
                        {busyClient === client.clientKey ? 'Please wait…'
                            : client.provider === 'google' ? 'Google account' : 'Apple account'}
                    </button>
                ))}
            </div>
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
    return (
        <div className="provider-sign-in">
            <ProviderSignInButtons clients={clients} action={action} busyClient={busyClient}
                disabled={disabled} onSelect={client => { void selectProvider(client); }} />
            {feedback && <p className={`provider-sign-in__feedback${feedback.error ? ' provider-sign-in__feedback--error' : ''}`}
                role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
        </div>
    );
}
