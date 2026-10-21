/** Public URLs are fixed: provider callbacks and native return intents cannot select destinations. */
export const APPLE_ANDROID_CALLBACK_URI = 'https://mickeyf.com/auth/providers/apple-android/callback';
export const APPLE_ANDROID_RETURN_URI = 'https://mickeyf.com/auth/native/apple-return';
export const APPLE_ANDROID_CLIENT_KEY = 'apple-android';

export function appleAndroidEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
    return env.APPLE_ANDROID_AUTH_ENABLED === 'true';
}
