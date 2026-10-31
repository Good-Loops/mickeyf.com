import notices from '../../public/third-party-notices.txt?raw';

/** Bundled locally so the same notices remain available without a connection. */
export default function ThirdPartyLicenses() {
    return <article className="privacy-notice" aria-labelledby="licenses-title">
        <h1 id="licenses-title">Third-party licenses</h1>
        <p>These notices describe open-source software and fonts included with Ludolume.</p>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{notices}</pre>
    </article>;
}
