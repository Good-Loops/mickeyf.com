import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '@/config/apiConfig';
import { apiFetch } from '@/services/apiFetch';
import { capturePageOwnership } from '@/services/pageOwnership';
import type { PageRequestInit } from '@/services/pageOwnership';

type Warning = { warningId: string; acknowledged: boolean; notice: { version: string; en: string; ptBR: string } };
type Status = { kind: 'loading' } | { kind: 'empty' } | { kind: 'unavailable' } | { kind: 'warning'; warning: Warning };
type Props = { childAccountId: string; sessionGeneration: number; refreshKey: number; selectionIsCurrent: () => boolean;
    captureAccountAction: () => number; captureSessionGeneration: () => number };

function readWarning(value: unknown): Warning | null | undefined {
    if (!value || typeof value !== 'object' || !('warning' in value)) return undefined;
    const warning = (value as { warning: unknown }).warning;
    if (warning === null) return null;
    if (!warning || typeof warning !== 'object') return undefined;
    const item = warning as Partial<Warning>;
    if (typeof item.warningId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[14][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.warningId)
        || typeof item.acknowledged !== 'boolean' || !item.notice || typeof item.notice.version !== 'string' || !item.notice.version
        || typeof item.notice.en !== 'string' || !item.notice.en || typeof item.notice.ptBR !== 'string' || !item.notice.ptBR
        || item.notice.en.length > 4000 || item.notice.ptBR.length > 4000) return undefined;
    return item as Warning;
}

/** This candidate requires a separately qualified backend and is never rendered by default. */
export default function ParentInactivityWarning({ childAccountId, sessionGeneration, refreshKey, selectionIsCurrent,
    captureAccountAction, captureSessionGeneration }: Props) {
    const [status, setStatus] = useState<Status>({ kind: 'loading' });
    const [retry, setRetry] = useState(0);
    const [busy, setBusy] = useState(false);
    const active = useRef<AbortController | null>(null);
    const isCurrentRef = useRef<() => boolean>(() => false);
    useEffect(() => {
        const controller = new AbortController();
        const ownsPage = capturePageOwnership(); const action = captureAccountAction();
        const isCurrent = () => !controller.signal.aborted && ownsPage() && selectionIsCurrent()
            && captureSessionGeneration() === sessionGeneration && captureAccountAction() === action;
        isCurrentRef.current = isCurrent;
        setStatus({ kind: 'loading' }); setBusy(false);
        const init: PageRequestInit = { method: 'POST', credentials: 'include', signal: controller.signal, isCurrent,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ childAccountId }) };
        void (async () => {
            try {
                if (!isCurrent()) return;
                const response = await apiFetch(`${API_BASE}/auth/child-inactivity/warning`, init);
                if (!response.ok) throw new Error('Warning unavailable.');
                const warning = readWarning(await response.json());
                if (warning === undefined) throw new Error('Invalid warning.');
                if (isCurrent()) setStatus(warning === null ? { kind: 'empty' } : { kind: 'warning', warning });
            } catch { if (isCurrent()) setStatus({ kind: 'unavailable' }); }
        })();
        return () => { controller.abort(); active.current?.abort(); active.current = null; isCurrentRef.current = () => false; };
    }, [childAccountId, sessionGeneration, refreshKey, retry, selectionIsCurrent, captureAccountAction, captureSessionGeneration]);

    async function acknowledge() {
        if (status.kind !== 'warning' || status.warning.acknowledged || active.current || !isCurrentRef.current()) return;
        const warningId = status.warning.warningId; const controller = new AbortController();
        const isCurrent = () => !controller.signal.aborted && isCurrentRef.current();
        active.current = controller; setBusy(true);
        try {
            const init: PageRequestInit = { method: 'POST', credentials: 'include', signal: controller.signal, isCurrent,
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ childAccountId, warningId, acknowledge: true }) };
            const response = await apiFetch(`${API_BASE}/auth/child-inactivity/acknowledge`, init);
            const result = response.ok ? await response.json() : null;
            if (!result || result.acknowledged !== true) throw new Error('Acknowledgment unavailable.');
            if (isCurrent()) setStatus(current => current.kind === 'warning' && current.warning.warningId === warningId
                ? { kind: 'warning', warning: { ...current.warning, acknowledged: true } } : current);
        } catch { if (isCurrent()) setStatus({ kind: 'unavailable' }); }
        finally { if (active.current === controller) { active.current = null; if (isCurrent()) setBusy(false); } }
    }

    if (status.kind === 'loading') return <p>Checking for an inactivity warning.</p>;
    if (status.kind === 'empty') return null;
    if (status.kind === 'unavailable') return <p role="status">We could not check the inactivity warning. <button type="button" onClick={() => setRetry(value => value + 1)}>Try again</button></p>;
    return <section aria-label="Child account inactivity warning">
        <h3>Inactivity warning</h3>
        <p lang="en">{status.warning.notice.en}</p>
        <p lang="pt-BR">{status.warning.notice.ptBR}</p>
        {status.warning.acknowledged ? <p role="status">You acknowledged this warning.</p> :
            <button type="button" disabled={busy} onClick={() => void acknowledge()}>I have read this warning</button>}
    </section>;
}
