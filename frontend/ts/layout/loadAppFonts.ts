const fontFamilies = [
    'Space+Mono:regular,italic,700,700italic',
    'Roboto:100,100italic,300,300italic,regular,italic,500,500italic,700,700italic,900,900italic',
    'Space+Grotesk:300,regular,500,600,700',
    'Work+Sans:100,200,300,regular,500,600,700,800,900,100italic,200italic,300italic,italic,500italic,600italic,700italic,800italic,900italic',
    'Fira+Sans:100,100italic,200,200italic,300,300italic,regular,italic,500,500italic,600,600italic,700,700italic,800,800italic,900,900italic',
];

/** Font availability must not delay the application's local layout stylesheet. */
export function loadAppFonts(documentRoot: Document = document): void {
    if (documentRoot.getElementById('app-fonts')) return;

    // A dynamically added stylesheet is not parser/render blocking; fallbacks remain usable.
    const stylesheet = documentRoot.createElement('link');
    stylesheet.id = 'app-fonts';
    stylesheet.rel = 'stylesheet';
    stylesheet.href = `https://fonts.googleapis.com/css?family=${fontFamilies.join('|')}&display=swap`;
    documentRoot.head.appendChild(stylesheet);
}
