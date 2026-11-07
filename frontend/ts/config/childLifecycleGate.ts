/** Both halves must be packaged together so a parent can respond to a warning. */
export function isChildLifecycleEnabled(activity: string | undefined, warning: string | undefined): boolean {
    return activity === '1' && warning === '1';
}
