type Environment = Readonly<Record<string, string | undefined>>;

/** Keep this on after collection is disabled until all withdrawal receipts expire. */
export function childDailyUsageReceiptRetentionEnabled(env: Environment, maintenance: boolean): boolean {
    const value = env.CHILD_DAILY_USAGE_RECEIPT_RETENTION_ENABLED;
    if (value === undefined || value === 'false') return false;
    if (value !== 'true') throw new Error('CHILD_DAILY_USAGE_RECEIPT_RETENTION_ENABLED must be true or false.');
    if (!maintenance) throw new Error('Daily usage receipt retention requires maintenance.');
    return true;
}

/** Keep the feature off until its parent, deletion and maintenance dependencies are ready. */
export function childDailyUsageEnabled(env: Environment, dependencies: {
    childAudience: boolean; signedForms: boolean; accountDeletion: boolean; maintenance: boolean; receiptRetention: boolean;
}): boolean {
    const value = env.CHILD_DAILY_USAGE_ENABLED;
    if (value === undefined || value === 'false') return false;
    if (value !== 'true') throw new Error('CHILD_DAILY_USAGE_ENABLED must be true or false.');
    if (!dependencies.childAudience || !dependencies.signedForms || !dependencies.accountDeletion || !dependencies.maintenance
        || !dependencies.receiptRetention) {
        throw new Error('Daily usage requires the reviewed child, deletion and retention maintenance configuration.');
    }
    return true;
}
