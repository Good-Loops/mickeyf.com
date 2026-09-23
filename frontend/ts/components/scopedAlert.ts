import type { SweetAlertOptions } from 'sweetalert2';
import Swal from './siteAlert';

/** Route-owned feedback may close only the popup it opened. */
export async function showScopedAlert(options: SweetAlertOptions, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    if (!signal) {
        await Swal.fire(options);
        return;
    }

    let popup: HTMLElement | undefined;
    const closeOwnedPopup = () => {
        if (popup && Swal.getPopup() === popup) Swal.close();
    };
    signal.addEventListener('abort', closeOwnedPopup, { once: true });
    try {
        await Swal.fire({
            ...options,
            didOpen: element => {
                popup = element;
                // SweetAlert schedules didOpen; the route can leave before it runs.
                if (signal.aborted) closeOwnedPopup();
                else options.didOpen?.(element);
            },
        });
    } finally {
        signal.removeEventListener('abort', closeOwnedPopup);
    }
}
