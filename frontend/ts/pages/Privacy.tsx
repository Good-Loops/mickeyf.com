import { useEffect } from 'react';
import notice from '../../../shared/privacyNotice.json' with { type: 'json' };

/** Public notice needs no account, API response or consent submission. */
export default function Privacy() {
    useEffect(() => {
        const target = window.location.hash === '#privacy-deletion' ? 'privacy-deletion'
            : window.location.hash === '#portugues' ? 'portugues' : null;
        if (target) document.getElementById(target)?.scrollIntoView();
    }, []);
    return <article className="privacy-notice" aria-labelledby="privacy-title">
        <h1 id="privacy-title">Ludolume privacy notice</h1>
        <p><a href="#portugues" lang="pt-BR">Leia este aviso em português</a></p>
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
        <section lang="pt-BR" aria-labelledby="portugues">
            <h2 id="portugues">{notice.ptBR.title}</h2>
            <p><a href="#privacy-title" lang="en">{notice.ptBR.englishLink}</a></p>
            <p>{notice.ptBR.availabilityText}</p>
            <p><a href={`mailto:${notice.contactEmail}`}>{notice.contactEmail}</a></p>
            {notice.ptBR.sections.map(section => <section key={section.id} aria-labelledby={`privacidade-${section.id}`}>
                <h3 id={`privacidade-${section.id}`}>{section.title}</h3>
                <p>{section.text}</p>
                {section.id === 'deletion' && <>
                    <p>{notice.ptBR.deletion.beforeAccount} <a href="/account">{notice.ptBR.deletion.accountLink}</a>{' '}
                        {notice.ptBR.deletion.betweenLinks} <a href="/parent-accounts">{notice.ptBR.deletion.parentLink}</a>{' '}
                        {notice.ptBR.deletion.afterLinks}</p>
                    <p>{notice.ptBR.deletion.beforeEmail}{' '}
                        <a href={`mailto:${notice.contactEmail}?subject=${encodeURIComponent(notice.ptBR.deletion.emailSubject)}`}>
                            {notice.ptBR.deletion.emailLink} {notice.contactEmail}</a>.{' '}{notice.ptBR.deletion.afterEmail}</p>
                </>}
            </section>)}
            <section aria-labelledby="privacidade-permissoes">
                <h3 id="privacidade-permissoes">{notice.ptBR.permissions.title}</h3>
                <p>{notice.ptBR.permissions.explanation}</p>
                <h4>{notice.ptBR.permissions.parentTitle}</h4>
                <p>{notice.signedParentForm.ptBR.parentConsent}</p>
                <h4>{notice.ptBR.permissions.publicTitle}</h4>
                <p>{notice.signedParentForm.ptBR.publicConsent}</p>
            </section>
            <p className="privacy-notice__version">{notice.ptBR.permissions.versionLabel}: {notice.version}</p>
        </section>
    </article>;
}
