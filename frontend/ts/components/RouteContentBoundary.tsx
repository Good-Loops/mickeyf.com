import { Component, Suspense, type ReactNode } from 'react';
import PageStatus from './PageStatus';

type RouteContentBoundaryProps = { children: ReactNode };
type RouteContentBoundaryState = { failed: boolean };

/** Route loading may fail independently of the persistent navigation and app shell. */
export default class RouteContentBoundary extends Component<RouteContentBoundaryProps, RouteContentBoundaryState> {
    state: RouteContentBoundaryState = { failed: false };

    static getDerivedStateFromError(): RouteContentBoundaryState {
        return { failed: true };
    }

    render() {
        if (this.state.failed) {
            return <PageStatus variant="error" />;
        }

        return (
            <Suspense fallback={<PageStatus variant="loading" />}>
                {this.props.children}
            </Suspense>
        );
    }
}
