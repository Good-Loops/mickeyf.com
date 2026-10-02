import { useId } from 'react';
import { Link } from 'react-router-dom';

type PageStatusProps = { variant: 'loading' | 'not-found' | 'error' };

const COPY = {
    'not-found': {
        eyebrow: 'SIGNAL LOST · 404',
        title: 'A little lost in space?',
        description: 'This page is outside our orbit. Let’s get you somewhere familiar.',
    },
    error: {
        eyebrow: 'CONNECTION INTERRUPTED',
        title: 'That world is out of reach',
        description: 'This page could not load. Try again, or head back home.',
    },
} as const;

/** Shared route feedback; CSS owns the decorative motion, never the navigation timing. */
export default function PageStatus({ variant }: PageStatusProps) {
    const titleId = useId();
    const descriptionId = useId();
    if (variant === 'loading') return (
        <section className="page-status page-status--loading" role="status" aria-live="polite">
            <span className="page-status__activity" aria-hidden="true"><span /><span /><span /></span>
            <span className="page-status__caption">Loading…</span>
        </section>
    );
    const copy = COPY[variant];
    const notFound = variant === 'not-found';

    return (
        <section
            className={`page-status page-status--${variant}`}
            role={variant === 'error' ? 'alert' : undefined}
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
        >
            <p className="page-status__eyebrow">{copy.eyebrow}</p>
            <div className="page-status__visual" aria-hidden="true">
                {notFound && <span className="page-status__digit">4</span>}
                <div className="page-status__orb">
                    <div className="page-status__ring page-status__ring--outer" />
                    <div className="page-status__ring page-status__ring--inner" />
                    <div className="page-status__core">
                        <svg className="page-status__controller" viewBox="0 0 32 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" focusable="false">
                            <path d="M10 5h12c4 0 6 4 7 10 1 5-3 6-6 2l-2-2H11l-2 2c-3 4-7 3-6-2 1-6 3-10 7-10Z" />
                            <path d="M10 8v6M7 11h6" />
                            <circle cx="22" cy="9" r=".9" />
                            <circle cx="25" cy="12" r=".9" />
                        </svg>
                    </div>
                </div>
                {notFound && <span className="page-status__digit">4</span>}
            </div>
            <h1 className="page-status__title" id={titleId}>{copy.title}</h1>
            <p className="page-status__description" id={descriptionId}>{copy.description}</p>
            <div className="page-status__actions">
                {notFound ? (
                    <>
                        <Link className="page-status__action page-status__action--primary" to="/">Go home</Link>
                        <Link className="page-status__action page-status__action--secondary" to="/games">Explore games</Link>
                    </>
                ) : (
                    <>
                        <button className="page-status__action page-status__action--primary" type="button" onClick={() => window.location.reload()}>Reload page</button>
                        <Link className="page-status__action page-status__action--secondary" to="/">Go home</Link>
                    </>
                )}
            </div>
        </section>
    );
}
