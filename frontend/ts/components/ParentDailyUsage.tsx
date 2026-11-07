import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '@/config/apiConfig';
import { apiFetch } from '@/services/apiFetch';
import { capturePageOwnership } from '@/services/pageOwnership';
import type { PageRequestInit } from '@/services/pageOwnership';
import type { ParentLanguage } from './parentAccountText';
import PrivacyNoticeLink from './PrivacyNoticeLink';
import notice from '../../../shared/childDailyUsageNotice.json' with { type: 'json' };

type Usage = { day: string; timeZone: string; dailyLimitMs: number; usedMs: number; remainingMs: number };
type Props = { language: ParentLanguage; childAccountId: string; sessionGeneration: number;
    selectionIsCurrent: () => boolean; captureAccountAction: () => number; captureSessionGeneration: () => number };
type Status = 'loading' | 'ready' | 'unavailable';

function readUsage(value: unknown): Usage | null | undefined {
    if (!value || typeof value !== 'object' || !('usage' in value)) return undefined;
    const usage = value.usage;
    if (usage === null) return null;
    if (!usage || typeof usage !== 'object') return undefined;
    const item = usage as Partial<Usage>;
    if (typeof item.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(item.day)
        || typeof item.timeZone !== 'string' || !item.timeZone || item.timeZone.length > 100
        || !Number.isSafeInteger(item.dailyLimitMs) || Number(item.dailyLimitMs) < 60_000 || Number(item.dailyLimitMs) > 86_400_000
        || !Number.isSafeInteger(item.usedMs) || Number(item.usedMs) < 0 || Number(item.usedMs) > 86_400_000
        || !Number.isSafeInteger(item.remainingMs) || Number(item.remainingMs) < 0 || Number(item.remainingMs) > Number(item.dailyLimitMs)) return undefined;
    return item as Usage;
}

/** Available only under the child-usage feature switch. */
export default function ParentDailyUsage({ language, childAccountId, sessionGeneration, selectionIsCurrent,
    captureAccountAction, captureSessionGeneration }: Props) {
    const tr = (en: string, pt: string) => language === 'pt-BR' ? pt : en;
    const [status, setStatus] = useState<Status>('loading');
    const [usage, setUsage] = useState<Usage | null>(null);
    const [minutes, setMinutes] = useState('');
    const [timeZone, setTimeZone] = useState('');
    const [busy, setBusy] = useState(false);
    const [consent, setConsent] = useState(false);
    const [feedback, setFeedback] = useState('');
    const [retry, setRetry] = useState(0);
    const active = useRef<AbortController | null>(null);
    const current = useRef<() => boolean>(() => false);
    useEffect(() => {
        const controller = new AbortController(), ownsPage = capturePageOwnership(), action = captureAccountAction();
        const isCurrent = () => !controller.signal.aborted && ownsPage() && selectionIsCurrent()
            && captureSessionGeneration() === sessionGeneration && captureAccountAction() === action;
        current.current = isCurrent; setStatus('loading'); setFeedback(''); setBusy(false); setConsent(false);
        const init: PageRequestInit = { method: 'POST', credentials: 'include', signal: controller.signal, isCurrent,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ childAccountId }) };
        void (async () => {
            try {
                if (!isCurrent()) return;
                const response = await apiFetch(`${API_BASE}/auth/child-daily-usage/get`, init);
                if (!response.ok) throw new Error('Unavailable.');
                const data = readUsage(await response.json());
                if (data === undefined) throw new Error('Invalid response.');
                if (isCurrent()) {
                    setUsage(data); setMinutes(data ? String(data.dailyLimitMs / 60_000) : '');
                    setTimeZone(data?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''); setStatus('ready');
                }
            } catch { if (isCurrent()) setStatus('unavailable'); }
        })();
        return () => { controller.abort(); active.current?.abort(); active.current = null; current.current = () => false; };
    }, [childAccountId, sessionGeneration, retry, selectionIsCurrent, captureAccountAction, captureSessionGeneration]);

    async function update(clear: boolean) {
        const limitMinutes = Number(minutes);
        if (active.current || !current.current() || (!clear && (!consent || !Number.isInteger(limitMinutes) || limitMinutes < 1 || limitMinutes > 1440 || !timeZone.trim()))) return;
        const controller = new AbortController(), isCurrent = () => !controller.signal.aborted && current.current();
        active.current = controller; setBusy(true); setFeedback('');
        try {
            const init: PageRequestInit = { method: 'POST', credentials: 'include', signal: controller.signal, isCurrent,
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(clear ? { childAccountId }
                    : { childAccountId, timeZone: timeZone.trim(), dailyLimitMs: limitMinutes * 60_000, consent: true, noticeVersion: notice.version }) };
            const response = await apiFetch(`${API_BASE}/auth/child-daily-usage/${clear ? 'clear' : 'set'}`, init);
            if (!response.ok) throw new Error('Unavailable.');
            const data = clear ? null : readUsage(await response.json());
            if (data === undefined) throw new Error('Invalid response.');
            if (isCurrent()) { setUsage(data); setConsent(false); setFeedback(clear ? 'cleared' : 'saved'); }
        } catch { if (isCurrent()) setFeedback('failed'); }
        finally { if (active.current === controller) { active.current = null; if (isCurrent()) setBusy(false); } }
    }
    if (status === 'loading') return <p>{tr('Checking daily use…', 'Consultando o uso diário…')}</p>;
    if (status === 'unavailable') return <p role="status">{tr('Could not check daily use.', 'Não foi possível consultar o uso diário.')}{' '}
        <button type="button" onClick={() => setRetry(value => value + 1)}>{tr('Try again', 'Tentar novamente')}</button></p>;
    return <section lang={language} aria-label={tr('Daily use', 'Uso diário')}>
        <h3>{tr('Daily use', 'Uso diário')}</h3>
        <p>{usage ? tr(`Used on ${usage.day}: ${Math.floor(usage.usedMs / 60_000)} min.`, `Uso em ${usage.day}: ${Math.floor(usage.usedMs / 60_000)} min.`)
            : tr('No daily limit is set.', 'Nenhum limite diário definido.')}</p>
        <p>{language === 'pt-BR' ? notice.ptBR : notice.en}</p>
        <p><PrivacyNoticeLink url={notice.privacyUrl} portuguese={language === 'pt-BR'} /></p>
        <label>{tr('Daily limit in minutes (1–1440)', 'Limite diário em minutos (1–1440)')}{' '}
            <input type="number" min="1" max="1440" step="1" value={minutes} disabled={busy} onChange={event => setMinutes(event.target.value)} /></label>
        <label>{tr('Time zone for the daily reset', 'Fuso horário para o reinício diário')}{' '}
            <input value={timeZone} maxLength={100} disabled={busy} onChange={event => setTimeZone(event.target.value)} /></label>
        <label><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />
            {tr('I agree to this optional usage collection for this child.', 'Concordo com esta coleta opcional de uso para esta criança.')}</label>{' '}
        <button type="button" disabled={busy || !minutes || !timeZone || !consent} onClick={() => void update(false)}>{tr('Save limit', 'Salvar limite')}</button>{' '}
        <button type="button" disabled={busy} onClick={() => void update(true)}>{tr('Turn off limit', 'Desativar limite')}</button>
        {feedback && <p role="status">{feedback === 'saved' ? tr('Limit saved.', 'Limite salvo.') : feedback === 'cleared'
            ? tr('Limit and current total removed.', 'Limite e total atual removidos.') : tr('Could not confirm the change. Refresh and try again.', 'Não foi possível confirmar a alteração. Atualize e tente novamente.')}</p>}
    </section>;
}
