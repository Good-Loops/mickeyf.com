import { useCallback, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import ChildDailyUsageGuard from './ChildDailyUsageGuard';

/** The switch remains off until the matching backend and privacy review are ready. */
export default function ChildDailyUsageBoundary({ children }: { children: ReactNode }) {
    const { isAuthenticated, loading, sessionGeneration, captureSessionGeneration } = useAuth();
    const { pathname } = useLocation();
    const capture = useRef(captureSessionGeneration);
    capture.current = captureSessionGeneration;
    const currentSession = useCallback(() => capture.current(), []);
    // Account and legal information must remain reachable after the time allowance ends.
    if (import.meta.env.VITE_ENABLE_CHILD_DAILY_USAGE !== '1'
        || ['/account', '/privacy', '/licenses'].includes(pathname)) return <>{children}</>;
    const language = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
    if (loading) return <p role="status" lang={language}>{language === 'pt-BR' ? 'Verificando sua conta…' : 'Checking your account…'}</p>;
    return <ChildDailyUsageGuard authenticated={isAuthenticated} sessionGeneration={sessionGeneration}
        captureSessionGeneration={currentSession} language={language}>{children}</ChildDailyUsageGuard>;
}
