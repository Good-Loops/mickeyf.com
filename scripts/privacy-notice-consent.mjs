// Offline public-text fragment only: never enables a policy or supplies country/age/assurance decisions.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function approvedPrivacyConsentEnvironment() {
    const notice = JSON.parse(await readFile(new URL('../shared/privacyNotice.json', import.meta.url), 'utf8'));
    return {
        PARENT_CONSENT_VERSION: notice.consent.parent.version,
        PARENT_CONSENT_TEXT: notice.consent.parent.text,
        PARENT_PRIVACY_NOTICE_URL: notice.noticeUrl,
        PUBLIC_SCORE_CONSENT_VERSION: notice.consent.publicScores.version,
        PUBLIC_SCORE_CONSENT_TEXT: notice.consent.publicScores.text,
        PUBLIC_SCORE_PRIVACY_NOTICE_URL: notice.noticeUrl,
    };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (process.argv.length !== 2) { console.error('No arguments: prints the approved public consent fragment only.'); process.exitCode = 1; }
    else console.log(JSON.stringify(await approvedPrivacyConsentEnvironment(), null, 2));
}
