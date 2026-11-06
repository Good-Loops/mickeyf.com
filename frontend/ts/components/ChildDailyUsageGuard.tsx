import { useEffect, useState, type ReactNode } from 'react';
import { API_BASE } from '@/config/apiConfig';
import { apiFetch } from '@/services/apiFetch';
import { interpretChildUsageLease } from '@/services/childDailyUsageLease';
import type { PageRequestInit } from '@/services/pageOwnership';
import type { ParentLanguage } from './parentAccountText';

type Status = 'checking' | 'unrestricted' | 'active' | 'limit' | 'unavailable';
type Props = { children: ReactNode; authenticated: boolean; sessionGeneration: number;
    captureSessionGeneration: () => number; language: ParentLanguage };

/** Prepared candidate only. Mounting requires native, offline and account-change qualification. */
export default function ChildDailyUsageGuard({ children, authenticated, sessionGeneration, captureSessionGeneration, language }: Props) {
    const [result, setResult] = useState<{ generation: number; authenticated: boolean; status: Status }>({ generation: sessionGeneration, authenticated, status: 'checking' });
    const status = result.generation === sessionGeneration && result.authenticated === authenticated ? result.status : 'checking';
    useEffect(() => {
        const setStatus = (next: Status) => setResult({ generation: sessionGeneration, authenticated, status: next });
        if (!authenticated) { setStatus('checking'); return; }
        let stopped = false, request: AbortController | null = null;
        let next: ReturnType<typeof setTimeout> | undefined, expiry: ReturnType<typeof setTimeout> | undefined,
            requestTimer: ReturnType<typeof setTimeout> | undefined;
        const current = () => !stopped && captureSessionGeneration() === sessionGeneration;
        const clearTimers = () => { clearTimeout(next); clearTimeout(expiry); next = undefined; expiry = undefined; };
        const schedule = (ms: number) => { clearTimeout(next); next = setTimeout(() => void check(), ms); };
        async function check() {
            if (!current() || document.visibilityState !== 'visible' || request) return;
            const controller = new AbortController(); request = controller;
            const isCurrent = () => current() && !controller.signal.aborted && document.visibilityState === 'visible';
            const started = performance.now();
            requestTimer = setTimeout(() => {
                if (request !== controller) return;
                controller.abort(); request = null;
                if (current() && document.visibilityState === 'visible') { clearTimers(); setStatus('unavailable'); schedule(15_000); }
            }, 15_000);
            try {
                const init: PageRequestInit = { method: 'POST', credentials: 'include', signal: controller.signal, isCurrent,
                    headers: { 'Content-Type': 'application/json' }, body: '{}' };
                const response = await apiFetch(`${API_BASE}/auth/child-daily-usage/heartbeat`, init);
                if (!response.ok) throw new Error('Usage unavailable.');
                const lease = interpretChildUsageLease(await response.json(), started, performance.now());
                if (!isCurrent()) return;
                clearTimers();
                // Supported account creation never converts an existing account into a managed child.
                // Recheck on a session change or return to the foreground, not every 30 seconds.
                if (lease.kind === 'not-managed') setStatus('unrestricted');
                else if (lease.kind === 'not-configured') { setStatus('unrestricted'); schedule(30_000); }
                else if (lease.kind === 'blocked') { setStatus(lease.remainingMs === 0 ? 'limit' : 'checking'); schedule(15_000); }
                else {
                    const left = Math.max(0, lease.deadline - performance.now());
                    if (left === 0) { setStatus('checking'); schedule(1_000); }
                    else {
                        setStatus('active');
                        expiry = setTimeout(() => { if (current()) setStatus('checking'); }, left);
                        schedule(Math.min(15_000, Math.max(1_000, left / 2)));
                    }
                }
            } catch {
                if (isCurrent()) { clearTimers(); setStatus('unavailable'); schedule(15_000); }
            } finally { if (request === controller) { clearTimeout(requestTimer); requestTimer = undefined; request = null; } }
        }
        const onVisibility = () => {
            clearTimers(); clearTimeout(requestTimer); requestTimer = undefined; request?.abort(); request = null;
            if (!current()) return;
            setStatus('checking');
            if (document.visibilityState === 'visible') void check();
        };
        setStatus('checking');
        document.addEventListener('visibilitychange', onVisibility);
        if (document.visibilityState === 'visible') void check();
        return () => { stopped = true; clearTimers(); clearTimeout(requestTimer); request?.abort(); document.removeEventListener('visibilitychange', onVisibility); };
    }, [authenticated, sessionGeneration, captureSessionGeneration]);
    if (!authenticated || status === 'unrestricted') return <>{children}</>;
    const tr = (en: string, pt: string) => language === 'pt-BR' ? pt : en;
    if (status === 'active') return <><p role="status" lang={language}>{tr('A parent set a daily time limit for this account.',
        'Um responsável definiu um limite diário de tempo para esta conta.')}</p>{children}</>;
    return <section role="status" lang={language}>
        {status === 'limit' ? tr('You have reached the daily time limit set by your parent.', 'Você atingiu o limite diário definido pelo seu responsável.')
            : status === 'unavailable' ? tr('We cannot check your daily time limit right now. Please try again when you are online.',
                'Não foi possível verificar seu limite diário agora. Tente novamente quando estiver online.')
                : tr('Checking your daily time limit…', 'Verificando seu limite diário…')}
    </section>;
}
