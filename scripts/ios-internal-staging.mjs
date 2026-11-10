const PRODUCTION_ORIGIN = 'https://mickeyf-org-j7yuum4tiq-uc.a.run.app';
const NOTICE_ID = 'ludolume-synthetic-notice';
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

/** One explicitly compiled temporary test endpoint, never a runtime backend selector. */
export function internalStagingConfiguration(host = '', distribution = 'internal-only', webOrigin = PRODUCTION_ORIGIN) {
    requireThat(typeof host === 'string', 'Internal staging host must be a string.');
    if (!host) {
        requireThat(webOrigin === PRODUCTION_ORIGIN, 'Ordinary signing requires the production web API origin.');
        return undefined;
    }
    requireThat(distribution === 'internal-only', 'Internal staging cannot produce an App Store eligible build.');
    requireThat(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/u.test(host),
        'Internal staging requires one exact lower-case Quick Tunnel hostname, without URL, port or path.');
    requireThat(webOrigin === `https://${host}`, 'Internal staging web and native API origins must match exactly.');
    return Object.freeze({ host, origin: webOrigin });
}

export function signingInfoPlist(info, staging) {
    requireThat(info.CFBundleDisplayName === 'Ludolume' && info.LudolumeInternalStaging === undefined,
        'Signing requires the ordinary source plist, not a previous staging output.');
    const result = { ...info, LudolumeStagingAPIHost: staging?.host ?? '' };
    if (staging) Object.assign(result, { CFBundleDisplayName: 'SYNTHETIC Ludolume', LudolumeInternalStaging: true,
        LudolumeGoogleSignInEnabled: false, LudolumeAppleSignInEnabled: false });
    return result;
}

export function stagingIndexHtml(html, staging) {
    requireThat(typeof html === 'string' && !html.includes(NOTICE_ID), 'Web assets already contain a staging notice.');
    if (!staging) return html;
    requireThat((html.match(/<body\b[^>]*>/gu) ?? []).length === 1, 'Expected one compiled app document body.');
    return html.replace(/<body\b[^>]*>/u, body => body + `\n<aside id="${NOTICE_ID}" role="status" style="position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:4px;background:#42264f;color:#fff;text-align:center;font:12px system-ui;pointer-events:none">SYNTHETIC TEST — test accounts only</aside>`);
}

/** Inspect the signed app's actual web assets and plist before any Apple upload. */
export function verifySignedApiConfiguration(info, indexHtml, mainBundle, staging, distribution) {
    const expected = staging?.origin ?? PRODUCTION_ORIGIN;
    const origins = [...mainBundle.matchAll(/\bproductionUrl:("(?:[^"\\]|\\.)*")/gu)].map(match => JSON.parse(match[1]));
    requireThat(origins.length === 1 && origins[0] === expected, 'Signed web assets do not contain the exact expected API origin.');
    if (staging) {
        requireThat(distribution === 'internal-only', 'Staging export must remain internal-only.');
        requireThat(info.LudolumeInternalStaging === true && info.LudolumeStagingAPIHost === staging.host
            && info.CFBundleDisplayName === 'SYNTHETIC Ludolume'
            && info.LudolumeGoogleSignInEnabled === false && info.LudolumeAppleSignInEnabled === false
            && indexHtml.includes(`id="${NOTICE_ID}"`) && indexHtml.includes('SYNTHETIC TEST'),
        'Signed staging identity, provider closure or visible notice is missing.');
    } else {
        requireThat(info.LudolumeInternalStaging === undefined && !info.LudolumeStagingAPIHost
            && info.CFBundleDisplayName === 'Ludolume' && !indexHtml.includes(NOTICE_ID),
        'Ordinary signed app contains staging configuration.');
    }
}
