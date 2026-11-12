import { useEffect, useState, type ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import { checkRegionalAge, type RegionalAgeOutcome } from '@/services/regionalAge';
import PageStatus from './PageStatus';

const isIos = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

/** The platform is asked only when its local regulatory signal requires a check. */
export default function RegionalAgeBoundary({ children, ios = isIos, check = checkRegionalAge }: {
    children: ReactNode; ios?: () => boolean; check?: () => Promise<RegionalAgeOutcome>;
}) {
    const [result, setResult] = useState<RegionalAgeOutcome | 'checking'>(() =>
        ios() ? 'checking' : 'continue');
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        if (!ios()) return;
        let active = true;
        setResult('checking');
        void check().then(value => { if (active) setResult(value); }).catch(() => { if (active) setResult('unknown'); });
        return () => { active = false; };
    }, [attempt, check, ios]);

    if (result === 'checking') return <PageStatus variant="loading" />;
    const portuguese = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('pt');
    if (result === 'required-unavailable') return <main className="main">
        <section className="page-status page-status--error" role="alert" lang={portuguese ? 'pt-BR' : 'en'}>
            <h1 className="page-status__title">{portuguese ? 'Informação de idade indisponível' : 'Age information unavailable'}</h1>
            <p className="page-status__description">{portuguese
                ? 'Seu aparelho exige uma verificação de idade para usar este app nesta região. Verifique os ajustes da sua Conta Apple e tente novamente.'
                : 'Your device requires an age check to use this app here. Check your Apple Account settings and try again.'}</p>
            <div className="page-status__actions">
                <button className="page-status__action page-status__action--primary" type="button"
                    onClick={() => setAttempt(value => value + 1)}>{portuguese ? 'Tentar novamente' : 'Try again'}</button>
            </div>
        </section>
    </main>;
    // An unknown regional signal is not a verified age. Preserve existing access, including guest use;
    // the applicable legal and offline fallback must be resolved before release.
    return children;
}
