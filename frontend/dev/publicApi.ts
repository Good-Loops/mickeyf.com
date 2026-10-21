import type { IncomingMessage } from 'node:http';
import type { Connect, Plugin } from 'vite';
import type { PublicAuthProtocol } from '../ts/config/publicAuthProtocol.ts';

export type { PublicAuthProtocol } from '../ts/config/publicAuthProtocol.ts';

export const PUBLIC_API_PREFIX = '/__public-api';
const PUBLIC_ORIGIN = 'https://mickeyf-org-j7yuum4tiq-uc.a.run.app';
const LOCAL_ORIGIN = 'http://localhost:5173';
const SESSION_COOKIES = {
    legacy: { local: 'ludolume_public_session', upstream: 'session' },
    renewable: { local: 'ludolume_public_web_session', upstream: '__session' },
} as const;
type SessionCookies = typeof SESSION_COOKIES[PublicAuthProtocol];
const MAX_BODY_BYTES = 32 * 1024;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const READ_ROUTES = new Set([
    '/auth/verify-token',
    '/api/leaderboards',
    '/api/leaderboards/p4-vega',
    '/api/leaderboards/three-bosses',
]);
const WRITE_ROUTES = new Set([
    '/api/users',
    '/auth/logout',
    '/api/leaderboards/three-bosses/run-tickets',
    '/api/leaderboards/three-bosses/runs',
]);
const PROVIDER_READ_ROUTES = new Set(['/auth/providers/config', '/auth/providers/account']);
const PROVIDER_WRITE_ROUTES = new Set(['/auth/providers/begin', '/auth/providers/complete']);
const PROVIDER_ACTIONS = new Set(['login', 'signup', 'link', 'delete']);
const USER_OPERATIONS = new Set(['login', 'signup', 'submit_score']);
// Preserve the upstream cookie encoding instead of reinterpreting its delimiters.
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;

class GatewayError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string) {
        super(code);
        this.status = status;
        this.code = code;
    }
}

function publicSessionCookie(header: string | undefined, names: SessionCookies): string | undefined {
    const matches = (header ?? '').split(';').map(part => part.trim())
        .filter(part => part.startsWith(`${names.local}=`));
    if (matches.length > 1) throw new GatewayError(400, 'INVALID_SESSION_COOKIE');
    if (matches.length === 0) return undefined;
    const value = matches[0].slice(names.local.length + 1);
    if (value.length > 8_192 || !COOKIE_VALUE.test(value)) {
        throw new GatewayError(400, 'INVALID_SESSION_COOKIE');
    }
    return `${names.upstream}=${value}`;
}

function localSessionCookie(header: string, names: SessionCookies): string | null {
    const [pair, ...attributes] = header.split(';').map(part => part.trim());
    if (!pair.startsWith(`${names.upstream}=`)) return null;
    const value = pair.slice(names.upstream.length + 1);
    if (!COOKIE_VALUE.test(value)) throw new GatewayError(502, 'INVALID_PUBLIC_RESPONSE');
    const lifetime = attributes.filter(attribute => /^(?:expires|max-age)=/i.test(attribute));
    // The upstream remains HTTPS. Only this loopback-only HTTP hop omits Secure;
    // its separate host-only cookie cannot leak into local-backend authentication.
    return [`${names.local}=${value}`, `Path=${PUBLIC_API_PREFIX}`, 'HttpOnly', 'SameSite=Lax', ...lifetime].join('; ');
}

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let finished = false;
        const finish = (error?: GatewayError) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            request.off('data', onData);
            request.off('end', onEnd);
            request.off('aborted', onError);
            if (error) {
                request.resume();
                reject(error);
            } else resolve(Buffer.concat(chunks).toString('utf8'));
        };
        const onData = (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) finish(new GatewayError(413, 'REQUEST_TOO_LARGE'));
            else chunks.push(chunk);
        };
        const onEnd = () => finish();
        const onError = () => finish(new GatewayError(400, 'INVALID_REQUEST'));
        const timeout = setTimeout(() => finish(new GatewayError(408, 'REQUEST_TIMEOUT')), 5_000);
        request.on('data', onData);
        request.once('end', onEnd);
        request.once('error', onError);
        request.once('aborted', onError);
    });
}

// The backend verifies proof and derives ownership from the signed session.
// This allowlist accepts only self-service shapes, never an account selector.
function validateSelfDeletionBody(route: string, body: Record<string, unknown>): void {
    const passwordDeletion = route === '/auth/delete-account';
    if (!passwordDeletion && !(PROVIDER_WRITE_ROUTES.has(route) && body.action === 'delete')) return;

    const fields = passwordDeletion ? ['password', 'confirmation']
        : route === '/auth/providers/begin' ? ['action', 'clientKey']
            : ['action', 'clientKey', 'state', 'idToken', 'confirmation'];
    const exactFields = Object.keys(body).length === fields.length
        && fields.every(field => Object.prototype.hasOwnProperty.call(body, field));
    const nonemptyText = (field: string) => typeof body[field] === 'string' && body[field].length > 0;
    const proofPresent = passwordDeletion ? nonemptyText('password')
        : body.clientKey === 'google-web' && (route === '/auth/providers/begin'
            || (nonemptyText('state') && nonemptyText('idToken')));
    if (!exactFields || !proofPresent
        || (route !== '/auth/providers/begin' && body.confirmation !== 'DELETE')) {
        throw new GatewayError(400, 'INVALID_REQUEST');
    }
}

async function mutationBody(request: IncomingMessage, route: string): Promise<string | undefined> {
    if (request.headers['content-encoding']) throw new GatewayError(415, 'JSON_REQUIRED');
    if (Number(request.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
        throw new GatewayError(413, 'REQUEST_TOO_LARGE');
    }
    const text = await readBody(request);
    if (route === '/auth/logout' && text === '') return undefined;
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
        throw new GatewayError(415, 'JSON_REQUIRED');
    }
    let body: unknown;
    try { body = JSON.parse(text); }
    catch { throw new GatewayError(400, 'INVALID_JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new GatewayError(400, 'INVALID_JSON');
    }
    if (route === '/api/users' && !USER_OPERATIONS.has((body as { type: string }).type)) {
        throw new GatewayError(404, 'NOT_FOUND');
    }
    if (PROVIDER_WRITE_ROUTES.has(route) && !PROVIDER_ACTIONS.has((body as { action: string }).action)) {
        throw new GatewayError(404, 'NOT_FOUND');
    }
    validateSelfDeletionBody(route, body as Record<string, unknown>);
    if ((route === '/auth/logout' || route === '/auth/renew') && Object.keys(body).length > 0) {
        throw new GatewayError(400, 'INVALID_REQUEST');
    }
    return JSON.stringify(body);
}

/** Opt-in real-account gateway, never a general-purpose development proxy. */
export function publicApiMiddleware(
    fetchPublic: typeof fetch = fetch, protocol: PublicAuthProtocol = 'legacy',
): Connect.NextHandleFunction {
    if (protocol !== 'legacy' && protocol !== 'renewable') throw new TypeError('Unknown public authentication protocol');
    const names = SESSION_COOKIES[protocol];
    return async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        try {
            const route = request.url ?? '';
            const mutation = request.method === 'POST';
            if (request.headers.host !== 'localhost:5173'
                || !LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? '')
                || (request.headers.origin !== undefined && request.headers.origin !== LOCAL_ORIGIN)
                || (mutation && request.headers.origin !== LOCAL_ORIGIN)) {
                throw new GatewayError(403, 'LOCAL_PREVIEW_ONLY');
            }
            const allowedRead = READ_ROUTES.has(route) || (protocol === 'renewable' && PROVIDER_READ_ROUTES.has(route));
            const allowedWrite = WRITE_ROUTES.has(route) || (protocol === 'renewable'
                && (route === '/auth/renew' || route === '/auth/delete-account' || PROVIDER_WRITE_ROUTES.has(route)));
            if (!(mutation ? allowedWrite : request.method === 'GET' && allowedRead)) {
                throw new GatewayError(404, 'NOT_FOUND');
            }
            if (!mutation && (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) > 0)) {
                throw new GatewayError(400, 'INVALID_REQUEST');
            }
            const cookie = publicSessionCookie(request.headers.cookie, names);
            const body = mutation ? await mutationBody(request, route) : undefined;
            const headers: Record<string, string> = { Accept: 'application/json' };
            if (request.headers.origin) headers.Origin = request.headers.origin;
            if (cookie) headers.Cookie = cookie;
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            const upstream = await fetchPublic(`${PUBLIC_ORIGIN}${route}`, {
                method: request.method, headers, body, credentials: 'omit',
                redirect: 'error', signal: AbortSignal.timeout(12_000),
            });
            const result = await upstream.text();
            if (!upstream.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
                throw new GatewayError(502, 'INVALID_PUBLIC_RESPONSE');
            }
            // Separate Set-Cookie values preserve Expires commas and clear-then-set order.
            const cookies = upstream.headers.getSetCookie().map(cookie => localSessionCookie(cookie, names))
                .filter((cookie): cookie is string => cookie !== null);
            if (cookies.length > 0) response.setHeader('Set-Cookie', cookies);
            response.statusCode = upstream.status;
            response.end(result);
        } catch (error) {
            response.statusCode = error instanceof GatewayError ? error.status : 502;
            response.end(JSON.stringify({ error: error instanceof GatewayError ? error.code : 'PUBLIC_API_UNAVAILABLE' }));
        }
    };
}

/** Select renewable only with the coordinated public backend/frontend cutover. */
export function publicApiPlugin(protocol: PublicAuthProtocol = 'legacy'): Plugin {
    return {
        name: 'public-api-preview',
        apply: 'serve',
        configureServer(server) {
            server.middlewares.use(PUBLIC_API_PREFIX, publicApiMiddleware(fetch, protocol));
        },
    };
}
