/**
 * Not-found route (catch-all).
 * Rendered when no client-side route matches.
 */
import PageStatus from '@/components/PageStatus';

export default function NotFound() {
    return <PageStatus variant="not-found" />;
}
