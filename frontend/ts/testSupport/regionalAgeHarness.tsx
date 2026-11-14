import { createRoot } from 'react-dom/client';
import RegionalAgeBoundary from '@/components/RegionalAgeBoundary';
import type { RegionalAgeOutcome } from '@/services/regionalAge';

export function mountRegionalAge(container: HTMLElement, outcomes: RegionalAgeOutcome[]) {
    let calls = 0;
    const check = async () => outcomes[Math.min(calls++, outcomes.length - 1)] ?? 'unknown';
    const root = createRoot(container);
    root.render(<RegionalAgeBoundary ios={() => true} check={check}><div>Guest content</div></RegionalAgeBoundary>);
    return { calls: () => calls, unmount: () => root.unmount() };
}
