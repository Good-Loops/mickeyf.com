import notice from '../../../shared/privacyNotice.json' with { type: 'json' };

/** Public notice needs no account, API response or consent submission. */
export default function Privacy() {
    return <article className="privacy-notice" aria-labelledby="privacy-title">
        <h1 id="privacy-title">Ludolume privacy notice</h1>
        <p>{notice.availabilityText}</p>
        <p><a href={`mailto:${notice.contactEmail}`}>{notice.contactEmail}</a></p>
        {notice.sections.map(section => <section key={section.id} aria-labelledby={`privacy-${section.id}`}>
            <h2 id={`privacy-${section.id}`}>{section.title}</h2>
            <p>{section.text}</p>
        </section>)}
        <section aria-labelledby="privacy-permissions">
            <h2 id="privacy-permissions">Separate permissions</h2>
            <p>Where these features are available, the account controls request the following permissions separately.
                Reading this notice does not grant either permission.</p>
            <h3>Parent permission for a child account</h3>
            <p>{notice.consent.parent.text}</p>
            <h3>Optional public leaderboard permission</h3>
            <p>{notice.consent.publicScores.text}</p>
        </section>
        <p className="privacy-notice__version">Notice version: {notice.version}</p>
    </article>;
}
