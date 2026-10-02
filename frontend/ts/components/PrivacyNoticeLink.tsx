import { parsePrivacyNoticeUrl } from '@/config/privacyNoticeUrl';

/** Keep the in-progress account flow open while the user reads the public notice. */
export default function PrivacyNoticeLink({ url = import.meta.env.VITE_PRIVACY_NOTICE_URL }: { url?: string }) {
    const href = parsePrivacyNoticeUrl(url);
    if (!href) return null;
    return <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
        Privacy notice <span>(opens in a new tab)</span>
    </a>;
}
