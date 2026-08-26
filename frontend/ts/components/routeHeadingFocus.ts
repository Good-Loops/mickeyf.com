/** The small DOM boundary used by route headings after client-side navigation. */
export type RouteHeadingFocusTarget = Pick<HTMLHeadingElement, 'focus'>;

/**
 * Moves keyboard focus without changing the reader's scroll position.
 * Kept separate from React so the accessibility behavior remains testable
 * without introducing a browser-DOM test dependency.
 */
export function focusRouteHeading(
    heading: RouteHeadingFocusTarget | null
): void {
    heading?.focus({ preventScroll: true });
}
