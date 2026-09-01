import {
    useEffect,
    useRef,
    type ComponentPropsWithoutRef,
} from 'react';
import { focusRouteHeading } from '@/components/routeHeadingFocus';

type RouteHeadingProps = Omit<ComponentPropsWithoutRef<'h1'>, 'tabIndex'> & {
    /** Refocuses an existing heading when the route's rendered state changes. */
    focusKey?: unknown;
};

/** Accessible page heading that receives focus after SPA navigation/state load. */
export function RouteHeading({ focusKey, ...headingProps }: RouteHeadingProps) {
    const headingRef = useRef<HTMLHeadingElement>(null);

    useEffect(() => {
        focusRouteHeading(headingRef.current);
    }, [focusKey]);

    return <h1 {...headingProps} ref={headingRef} tabIndex={-1} />;
}
