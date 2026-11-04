import { useEffect, useState } from 'react';
import { getAvailableProviderClients } from '@/services/providerClient';

export type SignupProvider = 'google' | 'apple';

/** A first-party method choice only. Provider SDKs and credentials stay behind eligibility. */
export default function SignupProviderChoices({ onChoose, selected, disabled }: {
    onChoose: (provider: SignupProvider) => void; selected: SignupProvider | null; disabled: boolean;
}) {
    const [providers, setProviders] = useState<SignupProvider[]>([]);
    useEffect(() => {
        let current = true;
        void getAvailableProviderClients().then(clients => {
            if (current) setProviders([...new Set(clients.filter(client => client.signup === true && client.issuance !== false)
                .map(client => client.provider))]);
        }).catch(() => { if (current) setProviders([]); });
        return () => { current = false; };
    }, []);

    if (providers.length === 0) return null;
    return <div className="signup-provider-choice" aria-label="Choose a sign-up method">
        <p>Choose a sign-up method, then check your country and age before continuing. To use email and a password, continue below.</p>
        {providers.map(provider => <button key={provider} type="button"
            className={`provider-sign-in__button provider-sign-in__button--${provider}`}
            aria-pressed={selected === provider} disabled={disabled}
            onClick={() => onChoose(provider)}>
            {provider === 'google' ? <span className="provider-sign-in__google-mark" aria-hidden="true">
                <img src="/images/google-sign-in-logo.svg" alt="" width="18" height="18" />
            </span> : <img src="/images/apple-sign-in-logo-white.png" alt="" aria-hidden="true" width="42" height="42" />}
            <span>Continue with {provider === 'google' ? 'Google' : 'Apple'}</span>
        </button>)}
    </div>;
}
