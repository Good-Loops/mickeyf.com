import { parsePrivacyNoticeUrl } from '@/config/privacyNoticeUrl';

/** Keep the in-progress account flow open while the user reads the public notice. */
export default function PrivacyNoticeLink({ url = import.meta.env.VITE_PRIVACY_NOTICE_URL, portuguese = false }: { url?: string; portuguese?: boolean }) {
    const href = parsePrivacyNoticeUrl(url);
    if (!href) return null;
    return <a href={portuguese ? `${href.split('#')[0]}#portugues` : href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
        lang={portuguese ? 'pt-BR' : undefined} aria-label={portuguese ? 'Aviso de privacidade (abre em outra aba)' : 'Privacy notice (opens in a new tab)'}>
        {portuguese ? 'Aviso de privacidade' : 'Privacy notice'}
    </a>;
}
