import Swal from './siteAlert';

/** Finish onboarding without keeping a provider token in UI state or browser storage. */
export async function requestProviderUsername(initialValue: string, signal: AbortSignal): Promise<string | null> {
    if (signal.aborted) return null;
    let popup: HTMLElement | undefined;
    const cancel = () => { if (popup && Swal.getPopup() === popup) Swal.close(); };
    signal.addEventListener('abort', cancel, { once: true });
    let onClosed!: () => void;
    const closed = new Promise<void>(resolve => { onClosed = resolve; });
    try {
        const decision = await Swal.fire<string>({
            title: 'Choose your username',
            text: 'This name appears on Ludolume leaderboards. You’ll sign in with Google—no password needed.',
            input: 'text', inputLabel: 'Ludolume username', inputValue: initialValue,
            inputAttributes: { autocomplete: 'username', autocapitalize: 'off', maxlength: '64' },
            inputValidator: value => value.trim().length > 0 && value.trim().length <= 64
                && !/[\u0000-\u001f\u007f]/.test(value) ? undefined : 'Enter a username (1–64 characters).',
            showCancelButton: true, confirmButtonText: 'Create account', cancelButtonText: 'Cancel',
            didOpen: element => { popup = element; if (signal.aborted) cancel(); },
            didDestroy: onClosed,
        });
        await closed;
        return !signal.aborted && decision.isConfirmed ? decision.value!.trim() : null;
    } finally {
        signal.removeEventListener('abort', cancel);
    }
}
