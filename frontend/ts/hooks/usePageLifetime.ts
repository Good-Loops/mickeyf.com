import { useEffect, useRef } from 'react';

/** Capture the current signal before awaiting work; a departed page cannot own feedback. */
export function usePageLifetime() {
    const lifetime = useRef<AbortSignal | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller.signal;
        return () => controller.abort();
    }, []);
    return lifetime;
}
