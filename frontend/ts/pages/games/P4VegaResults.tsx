import { useEffect, useRef, type RefObject } from 'react';
import type { P4RunResult } from '@/games/p4-Vega/p4RunResult';
import PersonalBestAlert from '@/components/PersonalBestAlert';

type P4VegaResultsProps = {
    result: P4RunResult;
    onRestart: () => void;
    onRetrySubmission: () => void;
    onHelp: () => void;
    fullscreenTargetRef: RefObject<HTMLDivElement | null>;
    helpDialogRef: RefObject<HTMLDialogElement | null>;
};

const submissionMessages: Record<P4RunResult['submission'], string> = {
    'signed-out': 'Log in before your next run to save scores.',
    submitting: 'Submitting score…',
    submitted: 'Score submitted. Your best score is kept.',
    failed: 'Your score could not be submitted.',
};

/** Results stay inside the canvas in both embedded and fullscreen play. */
export default function P4VegaResults({
    result,
    onRestart,
    onRetrySubmission,
    onHelp,
    fullscreenTargetRef,
    helpDialogRef,
}: P4VegaResultsProps) {
    const restartRef = useRef<HTMLButtonElement | null>(null);
    const completed = result.outcome === 'completed';

    useEffect(() => {
        // Submission updates must not take focus away from Retry or the guide.
        restartRef.current?.focus({ preventScroll: true });
    }, []);

    return (
        <div className="p4-vega__results-overlay" onKeyDown={(event) => event.stopPropagation()}>
            {result.submission === 'submitted' && result.personalBest && (
                <PersonalBestAlert
                    gameName="p4-Vega"
                    score={result.score}
                    fullscreenTargetRef={fullscreenTargetRef}
                    focusTargetRef={restartRef}
                    deferWhileOpenRef={helpDialogRef}
                />
            )}
            <section
                className="p4-vega__results-card"
                role="dialog"
                aria-labelledby="p4-results-heading"
                aria-describedby="p4-results-score"
                data-outcome={result.outcome}
            >
                <div className="p4-vega__results-body">
                    <h2 id="p4-results-heading">{completed ? 'Run complete' : 'Game over'}</h2>
                    <p className="p4-vega__results-score" id="p4-results-score">
                        <span>Score</span>
                        <strong>{result.score.toLocaleString('en-US')}</strong>
                    </p>
                    {result.personalBest && <span className="p4-vega__results-best">New personal best</span>}
                    <p
                        className="p4-vega__results-status"
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                        data-submission={result.submission}
                    >
                        {submissionMessages[result.submission]}
                    </p>
                    {result.submission === 'failed' && (
                        <button type="button" className="p4-vega__help-btn p4-vega__results-retry" onClick={onRetrySubmission}>
                            Retry score
                        </button>
                    )}
                </div>
                <div className="p4-vega__results-actions">
                    <button type="button" ref={restartRef} className="p4-vega__resume-btn" onClick={onRestart}>
                        {completed ? 'Play again' : 'Try again'}
                    </button>
                    <button type="button" className="p4-vega__help-btn" onClick={onHelp} aria-haspopup="dialog">
                        How to play
                    </button>
                </div>
            </section>
        </div>
    );
}
