import { createAppleNotificationVerifier, type AppleNotificationVerifier } from '../auth/appleNotificationVerifier';

/** Receiving revocations remains separately switchable from issuing new logins. */
export function loadAppleNotificationConfig(env: Readonly<Record<string, string | undefined>>,
    dependencies: Parameters<typeof createAppleNotificationVerifier>[1] = {}): AppleNotificationVerifier | undefined {
    if (env.APPLE_NOTIFICATIONS_ENABLED !== 'true') return undefined;
    const clientId = env.APPLE_IOS_BUNDLE_ID;
    if (!clientId || clientId.length > 255 || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(clientId)) {
        throw new Error('Apple notifications require one exact APPLE_IOS_BUNDLE_ID.');
    }
    return createAppleNotificationVerifier({ audiences: [clientId] }, dependencies);
}
