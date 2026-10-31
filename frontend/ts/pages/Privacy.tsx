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
            {section.id === 'deletion' && <>
                <p>In a browser, open <a href="/account">Account</a> or, where available,{' '}
                    <a href="/parent-accounts">Parent accounts</a> to use the deletion controls.</p>
                <p>To request deletion of your Ludolume account and associated data as described above without
                    reinstalling the app,{' '}
                    <a href={`mailto:${notice.contactEmail}?subject=${encodeURIComponent('Ludolume account deletion request')}`}>
                        email an account deletion request to {notice.contactEmail}</a>.
                    Account ownership must be verified before an emailed deletion request can be completed.
                    Do not send passwords or sign-in codes.</p>
            </>}
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
