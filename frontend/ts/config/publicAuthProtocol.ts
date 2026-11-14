export type PublicAuthProtocol = 'legacy' | 'renewable';

/** Pin the cookie contract at startup; never guess it from a failed request. */
export function parsePublicAuthProtocol(value: unknown): PublicAuthProtocol {
    if (value === undefined || value === 'legacy') return 'legacy';
    if (value === 'renewable') return 'renewable';
    throw new TypeError('VITE_PUBLIC_AUTH_PROTOCOL must be legacy or renewable');
}
