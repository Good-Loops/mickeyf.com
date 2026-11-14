import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { API_BASE } from '@/config/apiConfig';
import { isChildLifecycleEnabled } from '@/config/childLifecycleGate';
import { apiFetch } from '@/services/apiFetch';
import type { PageRequestInit } from '@/services/pageOwnership';

/** A parent sees this while signed in; the API never discloses which child needs attention. */
export default function ParentInactivityBanner() {
    const { isAuthenticated, userName, sessionGeneration, captureAccountAction, captureSessionGeneration } = useAuth();
    const onParentPage = useLocation().pathname === '/parent-accounts';
    const [pending, setPending] = useState(false);
    const current = useRef({ captureAccountAction, captureSessionGeneration });
    current.current = { captureAccountAction, captureSessionGeneration };
    useEffect(() => {
        setPending(false);
        if (!isChildLifecycleEnabled(import.meta.env.VITE_ENABLE_CHILD_ONLINE_ACTIVITY, import.meta.env.VITE_ENABLE_CHILD_INACTIVITY_WARNING) || !isAuthenticated || !userName || onParentPage) return;
        const controller = new AbortController();
        const action = current.current.captureAccountAction();
        const isCurrent = () => !controller.signal.aborted && current.current.captureAccountAction() === action
            && current.current.captureSessionGeneration() === sessionGeneration;
        const init: PageRequestInit = { method: 'POST', credentials: 'include', signal: controller.signal, isCurrent,
            headers: { 'Content-Type': 'application/json' }, body: '{}' };
        void (async () => {
            try {
                const response = await apiFetch(`${API_BASE}/auth/child-inactivity/pending`, init);
                if (!response.ok) return;
                const result: unknown = await response.json();
                if (isCurrent() && result && typeof result === 'object'
                    && Object.keys(result).join(',') === 'pending' && (result as { pending: unknown }).pending === true) setPending(true);
            } catch { /* A failed check never asserts that no warning exists. */ }
        })();
        return () => controller.abort();
    }, [isAuthenticated, userName, sessionGeneration, onParentPage]);
    return pending ? <p role="status" className="parent-inactivity-banner">
        A child account needs your attention. <Link to="/parent-accounts">Review the inactivity warning</Link>.
        <span lang="pt-BR"> Uma conta infantil precisa da sua atenção. <Link to="/parent-accounts">Ver o aviso de inatividade</Link>.</span>
    </p> : null;
}
