// Fetch public rendering resources before the application bundle; never initialize or request authentication.
(() => {
    const settings = document.currentScript;
    if (settings?.dataset.googleStartup === 'disabled'
        || !/^https?:$/.test(window.location.protocol)
        || window.Capacitor?.isNativePlatform?.()
        || !/^\/(?:login|signup)\/?$/.test(window.location.pathname)) return;
    for (const [kind, href] of [
        ['script', 'https://accounts.google.com/gsi/client?hl=en'],
        ['style', 'https://accounts.google.com/gsi/style'],
    ]) {
        if (document.head.querySelector(`link[data-google-signin-preload="${kind}"]`)) continue;
        const link = document.createElement('link');
        link.rel = 'preload';
        link.as = kind;
        link.href = href;
        link.dataset.googleSigninPreload = kind;
        document.head.appendChild(link);
    }
})();
