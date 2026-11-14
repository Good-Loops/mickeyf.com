/** Font availability must not delay the application's local layout stylesheet. */
export function loadAppFonts(documentRoot: Document = document): void {
    if (documentRoot.getElementById('app-fonts')) return;

    // A dynamically added stylesheet is not parser/render blocking; fallbacks remain usable.
    const stylesheet = documentRoot.createElement('link');
    stylesheet.id = 'app-fonts';
    stylesheet.rel = 'stylesheet';
    // Guest and child routes load fonts from the app without contacting a third-party font service.
    stylesheet.href = '/fonts/app-fonts.css';
    documentRoot.head.appendChild(stylesheet);
}
