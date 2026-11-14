import Swal from 'sweetalert2';

/** Shared site styling without changing SweetAlert's keyboard/focus behavior. */
const siteAlert = Swal.mixin({
    buttonsStyling: false,
    // The app shell already owns viewport sizing and Safari edge positioning.
    heightAuto: false,
    scrollbarPadding: false,
    customClass: {
        container: 'site-alert-container',
        popup: 'site-alert',
        title: 'site-alert__title',
        htmlContainer: 'site-alert__text',
        actions: 'site-alert__actions',
        confirmButton: 'site-alert__button',
        cancelButton: 'site-alert__button site-alert__button--secondary',
        denyButton: 'site-alert__button site-alert__button--secondary',
        closeButton: 'site-alert__close',
    },
});

export default siteAlert;
