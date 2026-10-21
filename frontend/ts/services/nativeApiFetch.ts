/** Adapts our small JSON API to the iOS cookie-owning native transport. */
export type NativeApiRequest = (options: {
    url: string;
    method: string;
    body?: string;
}) => Promise<{ status: number; body: string }>;

function throwIfAborted(signal?: AbortSignal | null): void {
    // iOS 15.0 supports AbortController, but not AbortSignal.throwIfAborted().
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

export function createNativeApiFetch(request: NativeApiRequest): typeof fetch {
    return async (input, init = {}) => {
        // Deliberately not a general fetch polyfill: assets, uploads and arbitrary
        // headers stay outside this session-bearing API boundary.
        if (typeof input !== 'string' && !(input instanceof URL)) {
            throw new TypeError('The native API requires a URL.');
        }
        if (init.credentials !== 'include' || (init.body != null && typeof init.body !== 'string')) {
            throw new TypeError('The native API requires cookie credentials and a JSON string body.');
        }
        const signal = init.signal;
        throwIfAborted(signal);

        return new Promise<Response>((resolve, reject) => {
            const abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            signal?.addEventListener('abort', abort, { once: true });
            const cleanup = () => signal?.removeEventListener('abort', abort);
            // Cancellation discards late results. Like fetch, it cannot promise
            // to undo a mutation the server has already received.
            Promise.resolve().then(() => {
                throwIfAborted(signal);
                return request({
                    url: input.toString(),
                    method: init.method ?? 'GET',
                    ...(typeof init.body === 'string' ? { body: init.body } : {}),
                });
            }).then(({ status, body }) => {
                throwIfAborted(signal);
                // Native code returns no headers, keeping Set-Cookie out of JS.
                resolve(new Response([204, 205, 304].includes(status) ? null : body, {
                    status,
                    headers: { 'Content-Type': 'application/json' },
                }));
            }).catch(reject).finally(cleanup);
        });
    };
}
