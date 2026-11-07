import { LEGACY_PUBLIC_API_PREVIEW, PUBLIC_API_PREVIEW } from '@/config/apiConfig';

/** Real-account previews remain explicit whichever cookie protocol is selected. */
export default function PublicAccountPreviewNotice() {
    if (!PUBLIC_API_PREVIEW) return null;
    return <p className="provider-sign-in__feedback">
        Accounts and scores are saved to the live service. {LEGACY_PUBLIC_API_PREVIEW
            ? 'Sign in with a password; sessions expire after four hours and do not renew.'
            : 'Renewable sign-in is enabled; provider options appear when available.'}
    </p>;
}
