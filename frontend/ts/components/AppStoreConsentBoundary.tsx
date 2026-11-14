import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { API_BASE } from '@/config/apiConfig';
import { apiFetch } from '@/services/apiFetch';
import { createAppStoreBindingClient, type AppStoreBindingResult } from '@/services/appStoreBinding';

const bind = createAppStoreBindingClient(API_BASE, apiFetch);

/** Enable only with the qualified server callback, recovery journal and child-session guard. */
export default function AppStoreConsentBoundary({ children }: { children: ReactNode }) {
    const auth = useAuth();
    const { pathname } = useLocation();
    const owner = useRef(auth);
    owner.current = auth;
    const [retry, setRetry] = useState(0);
    const [check, setCheck] = useState<{ key: string; result: AppStoreBindingResult } | null>(null);
    const [logoutFailed, setLogoutFailed] = useState(false);
    const enabled = import.meta.env.VITE_ENABLE_APP_STORE_CHILD_CONSENT === '1'
        && Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
    const action = auth.captureAccountAction();
    const generation = auth.sessionGeneration;
    const key = `${action}:${generation}:${retry}`;
    const required = enabled && auth.isAuthenticated && !auth.loading;

    useEffect(() => {
        if (!required) return;
        const controller = new AbortController();
        const isCurrent = () => !controller.signal.aborted
            && owner.current.captureAccountAction() === action
            && owner.current.captureSessionGeneration() === generation;
        void bind({ signal: controller.signal, isCurrent }).then(result => {
            if (isCurrent() && result !== 'cancelled') setCheck({ key, result });
        });
        return () => controller.abort();
    }, [required, action, generation, key]);

    // Legal information and guest use remain accessible during a failed association.
    if (!enabled || ['/privacy', '/licenses'].includes(pathname) || !auth.loading && !auth.isAuthenticated) return <>{children}</>;
    const result = check?.key === key ? check.result : null;
    // An unknown legacy age is not evidence that an adult account belongs to a child.
    if (required && (result === 'linked' || result === 'not-required' || result === 'unknown-age')) return <>{children}</>;
    const portuguese = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('pt');
    if (!result || auth.loading) return <p role="status" lang={portuguese ? 'pt-BR' : 'en'}>
        {portuguese ? 'Verificando sua conta…' : 'Checking your account…'}</p>;
    const restricted = result === 'not-permitted';
    return <section className="account" lang={portuguese ? 'pt-BR' : 'en'} aria-labelledby="app-store-consent-title">
        <h1 id="app-store-consent-title">{portuguese ? 'Acesso à conta' : 'Account access'}</h1>
        <p role="alert">{restricted
            ? portuguese ? 'Esta conta não pode continuar neste momento. Peça ajuda ao seu responsável.'
                : 'This account cannot continue right now. Ask your parent or guardian for help.'
            : portuguese ? 'Não foi possível confirmar o acesso desta conta pela Apple. Tente novamente ou saia da conta para continuar como visitante.'
                : 'We couldn’t confirm this account’s Apple access. Try again or sign out to continue as a guest.'}</p>
        <button type="button" onClick={() => setRetry(value => value + 1)}>{portuguese ? 'Tentar novamente' : 'Try again'}</button>
        <button type="button" onClick={() => {
            setLogoutFailed(false);
            void auth.logout().catch(() => setLogoutFailed(true));
        }}>{portuguese ? 'Sair da conta' : 'Sign out'}</button>
        {logoutFailed && <p role="alert">{portuguese ? 'Não foi possível sair da conta. Tente novamente.' : 'Could not sign out. Please try again.'}</p>}
        <a href="/privacy">{portuguese ? 'Aviso de privacidade' : 'Privacy notice'}</a>
    </section>;
}
