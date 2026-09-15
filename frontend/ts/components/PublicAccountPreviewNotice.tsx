import { PUBLIC_API_PREVIEW } from '@/config/apiConfig';

/** Keep the legacy public backend's limits visible without inventing capabilities. */
export default function PublicAccountPreviewNotice() {
    if (!PUBLIC_API_PREVIEW) return null;
    return <p className="provider-sign-in__feedback">
        Accounts and scores are saved to the live service. Sign in with a password;
        sessions expire after four hours and do not renew.
    </p>;
}
