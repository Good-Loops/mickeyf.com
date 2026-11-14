/** Disabled unless all production lifecycle dependencies are explicitly configured. */
export function parentFormRelayEnabled(value: string | undefined, dependencies: Readonly<{
    signedForms: boolean; appleNotifications: boolean; maintenance: boolean;
}>): boolean {
    if (value === undefined || value === '0') return false;
    if (value !== '1') throw new Error('PARENT_FORM_RELAY_STATE_ENABLED must be 0 or 1.');
    if (!dependencies.signedForms || !dependencies.appleNotifications || !dependencies.maintenance) {
        throw new Error('Parent relay state requires signed forms, Apple notifications and configured maintenance.');
    }
    return true;
}
