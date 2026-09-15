import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import cookieParser from 'cookie-parser';
import express from 'express';
import type { Pool } from 'mysql2/promise';
import { AccountDeletionPendingError } from '../accounts/accountDeletionRepository';
import { readProviderAccountMethods, type ProviderAccountCreationResult } from '../accounts/providerAccountRepository';
import { createProviderAuthContextReader } from '../auth/providerAuthContext';
import { createProviderAuthFlow, type ProviderAuthClient, type ProviderChallengeResult, type ProviderCompletionResult } from '../auth/providerAuthFlow';
import type { ProviderAttempt } from '../auth/providerAttemptRepository';
import type { VerifiedProviderIdentity } from '../auth/providerIdentity';
import { PROVIDER_TOKEN_MAX_LENGTH } from '../auth/providerTokenVerifier';
import { requestErrorHandler } from '../middleware/errorHandling';
import { issueSessionToken, type SessionProof } from '../security/sessionPolicy';
import { sessionCookieOptions } from '../security/sessionCookie';
import {
    createProviderAuthRouter, PROVIDER_BEGIN_IP_LIMIT, PROVIDER_COMPLETE_IP_LIMIT,
    PROVIDER_LINK_ACCOUNT_LIMIT, type ProviderAuthRouterServices,
} from './providerAuthRouter';

const secret = 'synthetic-provider-http-test-secret';
const origin = 'https://provider.example.test';
const account = { userId: 42, userName: 'provider-player', accountId: '11111111-2222-4333-8444-555555555555' };
const identity = { provider: 'google', subject: 'synthetic-provider-subject', email: 'synthetic@gmail.com' } as VerifiedProviderIdentity;
const beginInput = { clientKey: 'google-test', action: 'login' };
type FailureReason = Extract<ProviderCompletionResult, { ok: false }>['reason'];

function signedCookie(value: string, name = '__session') {
    const signature = createHmac('sha256', secret).update(value).digest('base64').replace(/=+$/, '');
    return `${name}=${encodeURIComponent(`s:${value}.${signature}`)}`;
}

type Features = { signupEnabled?: boolean; accountDeletionEnabled?: boolean; withJournal?: boolean; missingProviderTable?: boolean };

function fixture(features: Features = {}) {
    const state = {
        events: [] as string[], contextReads: 0, databaseReads: 0, verifiedNonces: [] as string[],
        rememberMe: [] as boolean[], proofs: [] as SessionProof[], linked: true, accountExists: true,
        sessionExists: true, sessionFailure: false, contextFailure: false,
        beginFailure: null as FailureReason | null, completionFailure: null as FailureReason | null,
        creation: { created: true, account } as ProviderAccountCreationResult,
        deletion: 'deleted' as 'deleted' | 'invalid-password' | 'not-found' | 'pending' | 'unavailable',
        methods: { hasPassword: false, googleLinked: true } as { hasPassword: boolean; googleLinked: boolean } | null,
        methodsFailure: false,
    };
    const attempts = new Map<string, ProviderAttempt>();
    const database = { async query(query: { sql: string }) {
        state.databaseReads++;
        if (state.contextFailure) throw new Error('private database details');
        if (features.missingProviderTable && query.sql.includes('user_password IS NOT NULL')) {
            return [[{ hasPassword: state.methods?.hasPassword ? 1 : 0 }], []];
        }
        if (features.missingProviderTable && query.sql.includes('FROM account_provider_identities')) {
            throw { errno: 1146, code: 'ER_NO_SUCH_TABLE' };
        }
        return [state.sessionExists ? [{ userName: account.userName }] : [], []];
    }, async getConnection() { throw new Error('No real database connection is allowed.'); } } as unknown as Pick<Pool, 'query' | 'getConnection'>;
    const clients: Record<string, ProviderAuthClient> = { 'google-test': {
        provider: 'google', verifier: { async verify(_provider, token, nonce) {
            state.events.push('verify');
            state.verifiedNonces.push(nonce);
            return token === 'accepted-token' || token === 'x'.repeat(PROVIDER_TOKEN_MAX_LENGTH)
                ? { verified: true, identity } : { verified: false, reason: 'INVALID_PROVIDER_TOKEN' };
        } },
    } };
    clients['google-web'] = clients['google-test'];
    const flow = createProviderAuthFlow({ enabled: true, clients, signupEnabled: features.signupEnabled,
        deletionEnabled: features.accountDeletionEnabled && features.withJournal, attempts: {
        async create(attempt) { state.events.push('create'); attempts.set(attempt.stateHash.toString('hex'), attempt); return 'created'; },
        async consume(hash, binding, client, action) {
            state.events.push('consume');
            const attempt = attempts.get(hash.toString('hex'));
            if (!attempt || !attempt.bindingHash.equals(binding) || attempt.clientKey !== client || attempt.action !== action) return null;
            attempts.delete(hash.toString('hex'));
            return attempt;
        },
    }, accounts: {
        async find(verified) { state.events.push('find'); assert.deepEqual(verified, identity); return state.linked ? account : null; },
        async link(target, password, verified, proof) {
            state.events.push('link');
            assert.deepEqual(target, { userId: account.userId, accountId: account.accountId });
            assert.equal(password, 'synthetic-password');
            assert.deepEqual(verified, identity);
            assert.ok(proof);
            state.proofs.push(proof);
            return 'linked';
        },
        async create(verified, userName) {
            state.events.push('signup');
            assert.deepEqual(verified, identity);
            assert.equal(userName, 'new-player');
            return state.creation;
        },
        async delete(target, verified, proof) {
            state.events.push('delete');
            assert.deepEqual(target, { userId: account.userId, accountId: account.accountId });
            assert.deepEqual(verified, identity);
            state.proofs.push(proof);
            if (state.deletion === 'pending') throw new AccountDeletionPendingError(new Error('private journal details'));
            if (state.deletion === 'unavailable') throw new Error('private deletion failure');
            return state.deletion;
        },
    } });
    const readContext = createProviderAuthContextReader({ database, sessionSecret: secret,
        allowedOrigins: [origin, 'capacitor://localhost'] });
    const services: ProviderAuthRouterServices = {
        async readContext(req, mode) { state.contextReads++; return readContext(req, mode); },
        flow: {
            async begin(context, input): Promise<ProviderChallengeResult> {
                return state.beginFailure ? { ok: false, reason: state.beginFailure } : flow.begin(context, input);
            },
            async complete(context, input): Promise<ProviderCompletionResult> {
                return state.completionFailure ? { ok: false, reason: state.completionFailure } : flow.complete(context, input);
            },
        },
        async establishSession(_database, _req, res, verifiedAccount, rememberMe, sessionSecret, isProduction) {
            state.events.push('session');
            assert.deepEqual(verifiedAccount, account);
            state.rememberMe.push(rememberMe);
            if (state.sessionFailure) throw new Error('private session details');
            if (!state.accountExists) return false;
            const issued = issueSessionToken(verifiedAccount, sessionSecret, rememberMe);
            res.cookie('__session', issued.token, { ...sessionCookieOptions(isProduction, '__session'), maxAge: issued.maxAge });
            return true;
        },
        async readAccountMethods(_database, accountId, options) {
            assert.equal(accountId, account.accountId);
            state.events.push('methods');
            if (state.methodsFailure) throw new Error('private account metadata');
            if (features.missingProviderTable) return readProviderAccountMethods(database, accountId, options);
            return state.methods;
        },
    };
    return { database, clients, services, state };
}

async function withServer(run: (base: string, setup: ReturnType<typeof fixture>) => Promise<void>, enabled = true,
    features: Features = {}) {
    const setup = fixture(features);
    const app = express();
    app.set('trust proxy', 1);
    app.use(cookieParser(secret));
    app.use('/auth/providers', createProviderAuthRouter({ ...setup, sessionSecret: secret,
        isProduction: true, allowedOrigins: [origin, 'capacitor://localhost'], enabled,
        signupEnabled: features.signupEnabled, accountDeletionEnabled: features.accountDeletionEnabled,
        ...(features.withJournal ? { deletionJournal: { async recordAccountDeletion() { assert.fail('fixture flow owns deletion'); } } } : {}),
    }));
    app.use(requestErrorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/providers`, setup); }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${base}/${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body) });
}

async function challenge(base: string, action = 'login', headers: Record<string, string> = {}) {
    const response = await post(base, 'begin', { ...beginInput, action,
        ...(action === 'signup' || action === 'delete' ? { clientKey: 'google-web' } : {}) }, headers);
    assert.equal(response.status, 200);
    const body = await response.json() as { state: string; nonce: string; expiresInSeconds: number };
    assert.match(body.state, /^[A-Za-z0-9_-]{43}$/);
    assert.match(body.nonce, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(body.expiresInSeconds >= 1 && body.expiresInSeconds <= 300);
    return { ...body, cookie: response.headers.getSetCookie()[0]?.split(';')[0] ?? headers.cookie ?? '', response };
}

test('disabled router has no provider endpoints or side effects, and enabled routes require clients', async () => {
    const setup = fixture();
    assert.throws(() => createProviderAuthRouter({ ...setup, clients: {}, enabled: true,
        sessionSecret: secret, isProduction: false, allowedOrigins: [origin] }), /configured clients/);
    await withServer(async (base, { state }) => {
        for (const path of ['begin', 'complete']) assert.equal((await post(base, path, {})).status, 404);
        assert.equal(state.contextReads, 0);
        assert.deepEqual(state.events, []);
    }, false);
});

test('anonymous challenge writes only the signed canonical transport cookie after a successful attempt', async () => {
    await withServer(async (base, { state }) => {
        for (const [requestOrigin, name, sameSite] of [[origin, '__session', 'Lax'], ['capacitor://localhost', 'session', 'None']]) {
            const result = await challenge(base, 'login', { origin: requestOrigin });
            const cookies = result.response.headers.getSetCookie();
            assert.equal(cookies.length, 1);
            assert.match(cookies[0], new RegExp(`^${name}=s%3Aprovider%3Av1%3A`));
            assert.match(cookies[0], /HttpOnly; Secure;/);
            assert.match(cookies[0], new RegExp(`SameSite=${sameSite}`));
            assert.equal(cookies[0].includes('provider_auth_binding'), false);
        }
        state.beginFailure = 'BUSY';
        const failed = await post(base, 'begin', beginInput);
        assert.equal(failed.status, 503);
        assert.deepEqual(await failed.json(), { error: 'BUSY' });
        assert.equal(failed.headers.get('set-cookie'), null);
        assert.deepEqual(state.events, ['create', 'create']);
    });
});

test('Origin, JSON, credential and account metadata failures do not create attempts or cookies', async () => {
    await withServer(async (base, { state }) => {
        const invalidHeaders: Record<string, string>[] = [
            { origin: 'https://attacker.example' }, { origin: 'null' },
            { authorization: 'Bearer untrusted' }, { 'content-type': 'text/plain' },
            { cookie: '__session=unsigned' }, { cookie: signedCookie('not-a-session') },
        ];
        for (const headers of invalidHeaders) {
            const response = await post(base, 'begin', beginInput, headers);
            assert.ok([400, 403].includes(response.status));
            assert.equal(response.headers.get('set-cookie'), null);
        }
        for (const body of [{ ...beginInput, accountId: account.accountId }, { ...beginInput, clientKey: 'unconfigured' },
            { ...beginInput, rememberMe: true }]) {
            const response = await post(base, 'begin', body);
            assert.equal(response.status, 400);
            assert.equal(response.headers.get('set-cookie'), null);
        }
        assert.deepEqual(state.events, []);
        assert.equal(state.databaseReads, 0);
    });
});

test('completion consumes the bound attempt, establishes the shared session and rejects replay without exposing internal proof', async () => {
    await withServer(async (base, { state }) => {
        const started = await challenge(base);
        const input = { ...beginInput, state: started.state, idToken: 'accepted-token', rememberMe: true };
        const response = await post(base, 'complete', input, { cookie: started.cookie });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { success: true, user_name: account.userName });
        assert.match(response.headers.get('set-cookie')!, /^__session=s%3Aey/);
        assert.deepEqual(state.events, ['create', 'consume', 'verify', 'find', 'session']);
        assert.deepEqual(state.verifiedNonces, [started.nonce]);
        assert.deepEqual(state.rememberMe, [true]);
        const replay = await post(base, 'complete', input, { cookie: started.cookie });
        assert.equal(replay.status, 400);
        assert.deepEqual(await replay.json(), { error: 'INVALID_ATTEMPT' });
        assert.equal(replay.headers.get('set-cookie'), null);
        assert.equal(state.rememberMe.length, 1);
    });
});

test('missing binding never bootstraps during completion, and strict rememberMe validation precedes flow work', async () => {
    await withServer(async (base, { state }) => {
        const input = { ...beginInput, state: 'x'.repeat(43), idToken: 'accepted-token' };
        const missing = await post(base, 'complete', input);
        assert.equal(missing.status, 403);
        assert.equal(missing.headers.get('set-cookie'), null);
        for (const body of [{ ...input, rememberMe: 'true' }, { ...input, rememberMe: 1 },
            { ...input, action: 'link', password: 'synthetic-password', rememberMe: false },
            { ...input, expectedNonce: 'untrusted' }]) {
            const result = await post(base, 'complete', body);
            assert.equal(result.status, 400);
            assert.equal(result.headers.get('set-cookie'), null);
        }
        assert.deepEqual(state.events, []);
    });
});

test('an old anonymous challenge cannot survive a new login cookie, logout or a replacement begin', async () => {
    await withServer(async (base, { state }) => {
        const original = await challenge(base);
        const input = { ...beginInput, state: original.state, idToken: 'accepted-token' };
        const loggedInCookie = signedCookie(issueSessionToken(account, secret).token);
        const transitions: Record<string, string>[] = [{ cookie: loggedInCookie }, {}];
        for (const headers of transitions) {
            const response = await post(base, 'complete', input, headers);
            assert.equal(response.status, 403);
            assert.deepEqual(await response.json(), { error: 'INVALID_CONTEXT' });
            assert.equal(response.headers.get('set-cookie'), null);
        }
        const replacement = await challenge(base, 'login', { cookie: original.cookie });
        assert.notEqual(replacement.cookie, original.cookie);
        const replaced = await post(base, 'complete', input, { cookie: replacement.cookie });
        assert.equal(replaced.status, 400);
        assert.deepEqual(await replaced.json(), { error: 'INVALID_ATTEMPT' });
        assert.equal(replaced.headers.get('set-cookie'), null);
        assert.deepEqual(state.verifiedNonces, []);
        assert.deepEqual(state.rememberMe, []);
    });
});

test('link completion keeps the existing cookie and forwards the live device proof', async () => {
    await withServer(async (base, { state }) => {
        const session = issueSessionToken(account, secret);
        const cookie = signedCookie(session.token);
        const started = await challenge(base, 'link', { cookie });
        assert.equal(started.response.headers.get('set-cookie'), null);
        const response = await post(base, 'complete', { ...beginInput, action: 'link', state: started.state,
            idToken: 'accepted-token', password: 'synthetic-password' }, { cookie });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { success: true, linked: true });
        assert.equal(response.headers.get('set-cookie'), null);
        assert.deepEqual(state.proofs, [{ accountId: account.accountId, sessionId: session.sessionId }]);
        assert.deepEqual(state.events, ['create', 'consume', 'verify', 'link']);
        assert.deepEqual(state.rememberMe, []);
    });
});

test('context storage failure is sanitized without creating attempts or replacing the current session', async () => {
    await withServer(async (base, { state }) => {
        state.contextFailure = true;
        const cookie = signedCookie(issueSessionToken(account, secret).token);
        const response = await post(base, 'begin', { ...beginInput, action: 'link' }, { cookie });
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: 'UNAVAILABLE' });
        assert.equal(response.headers.get('set-cookie'), null);
        assert.deepEqual(state.events, []);
    });
});

test('unknown provider accounts, failed session commits and removed accounts never issue authentication cookies', async () => {
    await withServer(async (base, { state }) => {
        for (const failure of ['unlinked', 'removed', 'unavailable']) {
            state.linked = failure !== 'unlinked';
            state.accountExists = failure !== 'removed';
            state.sessionFailure = failure === 'unavailable';
            const started = await challenge(base);
            const response = await post(base, 'complete', { ...beginInput, state: started.state, idToken: 'accepted-token' },
                { cookie: started.cookie });
            assert.equal(response.status, failure === 'unlinked' ? 403 : failure === 'removed' ? 401 : 503);
            assert.deepEqual(await response.json(), { error: failure === 'unlinked' ? 'NOT_LINKED' : failure === 'removed' ? 'ACCOUNT_GONE' : 'UNAVAILABLE' });
            assert.equal(response.headers.get('set-cookie'), null);
        }
        assert.deepEqual(state.rememberMe, [false, false]);
    });
});

test('full-size ID tokens fit the JSON budget, but token and total body bounds remain enforced', async () => {
    await withServer(async (base, { state }) => {
        const started = await challenge(base);
        const input = { ...beginInput, state: started.state, idToken: 'x'.repeat(PROVIDER_TOKEN_MAX_LENGTH) };
        const accepted = await post(base, 'complete', input, { cookie: started.cookie });
        assert.equal(accepted.status, 200);
        const oversizedToken = await post(base, 'complete', { ...input, idToken: `${input.idToken}x` }, { cookie: started.cookie });
        assert.equal(oversizedToken.status, 400);
        const reads = state.contextReads;
        const oversizedBody = await post(base, 'complete', { ...input, extra: 'x'.repeat(32 * 1024) }, { cookie: started.cookie });
        assert.equal(oversizedBody.status, 413);
        assert.deepEqual(await oversizedBody.json(), { error: 'PAYLOAD_TOO_LARGE' });
        assert.equal(state.contextReads, reads);
        assert.equal(state.rememberMe.length, 1);
    });
});

test('all flow failures have fixed HTTP mappings and never leak internal result fields', async () => {
    await withServer(async (base, { state }) => {
        const statuses: Record<FailureReason, number> = { UNAVAILABLE: 503, INVALID_REQUEST: 400, INVALID_CONTEXT: 403,
            BUSY: 503, INVALID_ATTEMPT: 400, INVALID_PROVIDER_TOKEN: 401, NOT_LINKED: 403,
            INVALID_PASSWORD: 403, LINK_CONFLICT: 409, ACCOUNT_GONE: 401,
            DUPLICATE_USER: 409, ALREADY_LINKED: 409, INVALID_USERNAME: 400, INVALID_EMAIL: 400,
            ACCOUNT_DELETION_UNAVAILABLE: 503, ACCOUNT_DELETION_PENDING: 503 };
        for (const [reason, status] of Object.entries(statuses)) {
            state.completionFailure = reason as FailureReason;
            const response = await post(base, 'complete', beginInput);
            assert.equal(response.status, status);
            assert.deepEqual(await response.json(), { error: reason });
            assert.equal(response.headers.get('set-cookie'), null);
        }
    });
});

test('begin and complete have independent IP ceilings before context or provider work', async () => {
    await withServer(async (base, { state }) => {
        for (const [path, limit] of [['begin', PROVIDER_BEGIN_IP_LIMIT], ['complete', PROVIDER_COMPLETE_IP_LIMIT]] as const) {
            for (let index = 0; index < limit; index++) assert.notEqual((await post(base, path, {})).status, 429);
            const reads = state.contextReads;
            const blocked = await post(base, path, {});
            assert.equal(blocked.status, 429);
            assert.deepEqual(await blocked.json(), { error: 'RATE_LIMITED' });
            assert.equal(state.contextReads, reads);
        }
        assert.deepEqual(state.events, []);
    });
});

test('link password attempts share an account ceiling across sessions and IPs before verification', async () => {
    await withServer(async (base, { state }) => {
        for (let index = 0; index <= PROVIDER_LINK_ACCOUNT_LIMIT; index++) {
            const session = issueSessionToken(account, secret);
            const headers = { cookie: signedCookie(session.token), 'x-forwarded-for': `192.0.2.${index + 1}` };
            const started = await challenge(base, 'link', headers);
            const reads = state.contextReads;
            const response = await post(base, 'complete', { ...beginInput, action: 'link', state: started.state,
                idToken: 'rejected-token', password: 'synthetic-password' }, headers);
            assert.equal(response.status, index === PROVIDER_LINK_ACCOUNT_LIMIT ? 429 : 401);
            if (index === PROVIDER_LINK_ACCOUNT_LIMIT) assert.equal(state.contextReads, reads);
            assert.equal(response.headers.get('set-cookie'), null);
        }
        assert.equal(state.verifiedNonces.length, PROVIDER_LINK_ACCOUNT_LIMIT);
        assert.equal(state.proofs.length, 0);
    });
});

test('signup and Google deletion stay unavailable without their independent capability gates', async () => {
    for (const features of [{}, { accountDeletionEnabled: true }, { withJournal: true }]) {
        await withServer(async (base, { state }) => {
            for (const [action, error] of [['signup', 'UNAVAILABLE'], ['delete', 'ACCOUNT_DELETION_UNAVAILABLE']]) {
                for (const path of ['begin', 'complete']) {
                    const response = await post(base, path, { clientKey: 'google-web', action });
                    assert.equal(response.status, 503);
                    assert.deepEqual(await response.json(), { error });
                    assert.equal(response.headers.get('set-cookie'), null);
                }
            }
            assert.deepEqual(state.events, []);
            assert.equal(state.contextReads, 0);
        }, true, features);
    }
});

test('explicit Google signup establishes the normal cookie only after account creation succeeds', async () => {
    await withServer(async (base, { state }) => {
        const started = await challenge(base, 'signup');
        const input = { action: 'signup', clientKey: 'google-web', state: started.state,
            idToken: 'accepted-token', userName: ' new-player ', rememberMe: true };
        const invalid = await post(base, 'complete', { ...input, rememberMe: 'true' }, { cookie: started.cookie });
        assert.equal(invalid.status, 400);
        assert.equal(invalid.headers.get('set-cookie'), null);
        const response = await post(base, 'complete', input, { cookie: started.cookie });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { success: true, user_name: account.userName });
        assert.match(response.headers.get('set-cookie')!, /^__session=s%3Aey/);
        assert.deepEqual(state.events, ['create', 'consume', 'verify', 'signup', 'session']);
        assert.deepEqual(state.rememberMe, [true]);
        const replay = await post(base, 'complete', input, { cookie: started.cookie });
        assert.equal(replay.status, 400);
        assert.equal(replay.headers.get('set-cookie'), null);
    }, true, { signupEnabled: true });
});

test('Google signup email and username conflicts never log in an existing account or set a session cookie', async () => {
    await withServer(async (base, { state }) => {
        state.linked = false;
        for (const [reason, status] of [['DUPLICATE_USER', 409],
            ['INVALID_USERNAME', 400], ['INVALID_EMAIL', 400]] as const) {
            state.creation = { created: false, reason };
            const started = await challenge(base, 'signup');
            const response = await post(base, 'complete', { action: 'signup', clientKey: 'google-web', state: started.state,
                idToken: 'accepted-token', userName: 'new-player' }, { cookie: started.cookie });
            assert.equal(response.status, status);
            assert.deepEqual(await response.json(), { error: reason });
            assert.equal(response.headers.get('set-cookie'), null);
        }
        assert.deepEqual(state.rememberMe, []);
        assert.ok(!state.events.includes('link'));
    }, true, { signupEnabled: true });
});

test('Google login continues new-user signup using the same cookie and nonce, and issues a session only afterward', async () => {
    await withServer(async (base, { state }) => {
        state.linked = false;
        const begun = await post(base, 'begin', { clientKey: 'google-web', action: 'login' });
        const started = await begun.json() as { state: string; nonce: string; expiresInSeconds: number };
        const cookie = begun.headers.getSetCookie()[0].split(';')[0];
        const response = await post(base, 'complete', { clientKey: 'google-web', action: 'login',
            state: started.state, idToken: 'accepted-token', rememberMe: true }, { cookie });
        assert.equal(response.status, 200);
        const next = await response.json() as { signupRequired: boolean; challenge: typeof started };
        assert.equal(next.signupRequired, true);
        assert.equal(next.challenge.nonce, started.nonce);
        assert.notEqual(next.challenge.state, started.state);
        assert.ok(next.challenge.expiresInSeconds <= started.expiresInSeconds);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.deepEqual(state.rememberMe, []);
        const registered = await post(base, 'complete', { clientKey: 'google-web', action: 'signup',
            state: next.challenge.state, idToken: 'accepted-token', userName: 'new-player', rememberMe: true }, { cookie });
        assert.equal(registered.status, 200);
        assert.deepEqual(await registered.json(), { success: true, user_name: account.userName });
        assert.match(registered.headers.get('set-cookie')!, /^__session=s%3Aey/);
        assert.deepEqual(state.rememberMe, [true]);
        assert.deepEqual(state.verifiedNonces, [started.nonce, started.nonce]);
    }, true, { signupEnabled: true });
});

test('confirmed fresh-Google deletion clears both authentication cookies and never establishes a replacement session', async () => {
    await withServer(async (base, { state }) => {
        const session = issueSessionToken(account, secret);
        const cookie = signedCookie(session.token);
        const started = await challenge(base, 'delete', { cookie });
        assert.equal(started.response.headers.get('set-cookie'), null);
        const input = { action: 'delete', clientKey: 'google-web', state: started.state,
            idToken: 'accepted-token', confirmation: 'DELETE' };
        const malformed = await post(base, 'complete', { ...input, rememberMe: false }, { cookie });
        assert.equal(malformed.status, 400);
        assert.equal(malformed.headers.get('set-cookie'), null);
        const response = await post(base, 'complete', input, { cookie });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { success: true, deleted: true });
        const cleared = response.headers.getSetCookie();
        assert.equal(cleared.length, 2);
        assert.ok(cleared.some(value => value.startsWith('__session=')));
        assert.ok(cleared.some(value => value.startsWith('session=')));
        assert.ok(cleared.every(value => value.includes('Expires=Thu, 01 Jan 1970')));
        assert.deepEqual(state.proofs, [{ accountId: account.accountId, sessionId: session.sessionId }]);
        assert.deepEqual(state.events, ['create', 'consume', 'verify', 'delete']);
        assert.deepEqual(state.rememberMe, []);
        const replay = await post(base, 'complete', input, { cookie });
        assert.equal(replay.status, 400);
        assert.equal(replay.headers.get('set-cookie'), null);
    }, true, { accountDeletionEnabled: true, withJournal: true });
});

test('wrong Google identity, removed accounts and uncertain deletion preserve cookies and return fixed failures', async () => {
    await withServer(async (base, { state }) => {
        const cookie = signedCookie(issueSessionToken(account, secret).token);
        for (const [deletion, status, error] of [['invalid-password', 401, 'INVALID_PROVIDER_TOKEN'],
            ['not-found', 401, 'ACCOUNT_GONE'], ['pending', 503, 'ACCOUNT_DELETION_PENDING'],
            ['unavailable', 503, 'ACCOUNT_DELETION_UNAVAILABLE']] as const) {
            state.deletion = deletion;
            const started = await challenge(base, 'delete', { cookie });
            const response = await post(base, 'complete', { action: 'delete', clientKey: 'google-web', state: started.state,
                idToken: 'accepted-token', confirmation: 'DELETE' }, { cookie });
            assert.equal(response.status, status);
            assert.deepEqual(await response.json(), { error });
            assert.equal(response.headers.get('set-cookie'), null);
        }
        assert.deepEqual(state.rememberMe, []);
    }, true, { accountDeletionEnabled: true, withJournal: true });
});

test('account methods expose only booleans after signed-cookie and live-session verification', async () => {
    await withServer(async (base, { state }) => {
        const cookie = signedCookie(issueSessionToken(account, secret).token);
        const response = await fetch(`${base}/account`, { headers: { cookie } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await response.json(), { hasPassword: false, googleLinked: true, googleDeletionEnabled: true });
        assert.equal(response.headers.get('set-cookie'), null);
        assert.deepEqual(state.events, ['methods']);
        state.methods = { hasPassword: true, googleLinked: false };
        const passwordOnly = await fetch(`${base}/account`, { headers: { cookie } });
        assert.deepEqual(await passwordOnly.json(), { hasPassword: true, googleLinked: false, googleDeletionEnabled: false });
        state.methods = null;
        assert.equal((await fetch(`${base}/account`, { headers: { cookie } })).status, 401);
        state.methodsFailure = true;
        const failure = await fetch(`${base}/account`, { headers: { cookie } });
        assert.equal(failure.status, 503);
        assert.deepEqual(await failure.json(), { error: 'UNAVAILABLE' });
    }, true, { accountDeletionEnabled: true, withJournal: true });
});

test('account methods reject unsigned, bearer, conflicting and stale sessions without returning metadata', async () => {
    await withServer(async (base, { state }) => {
        const session = issueSessionToken(account, secret);
        const cookie = signedCookie(session.token);
        const invalidHeaders: Record<string, string>[] = [{}, { cookie: '__session=unsigned' }, { authorization: `Bearer ${session.token}` },
            { cookie, authorization: `Bearer ${session.token}` }, { cookie: `${cookie}; ${signedCookie(session.token, 'session')}` }];
        for (const headers of invalidHeaders) {
            const response = await fetch(`${base}/account`, { headers });
            assert.equal(response.status, 401);
            assert.deepEqual(await response.json(), { error: 'UNAUTHENTICATED' });
        }
        state.sessionExists = false;
        assert.equal((await fetch(`${base}/account`, { headers: { cookie } })).status, 401);
        assert.deepEqual(state.events, []);
    });
});

test('account methods remain available for password users when provider authentication is disabled', async () => {
    await withServer(async (base, { state }) => {
        state.methods = { hasPassword: true, googleLinked: false };
        const cookie = signedCookie(issueSessionToken(account, secret).token);
        const response = await fetch(`${base}/account`, { headers: { cookie } });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { hasPassword: true, googleLinked: false, googleDeletionEnabled: false });
        assert.deepEqual(state.events, ['methods']);
        assert.equal((await post(base, 'begin', beginInput)).status, 404);
    }, false);
});

test('old-schema metadata works only for verified password users with provider authentication disabled', async () => {
    for (const [enabled, hasPassword, status] of [[false, true, 200], [true, true, 503], [false, false, 503]] as const) {
        await withServer(async (base, { state }) => {
            state.methods = { hasPassword, googleLinked: false };
            const cookie = signedCookie(issueSessionToken(account, secret).token);
            const response = await fetch(`${base}/account`, { headers: { cookie } });
            assert.equal(response.status, status);
            assert.deepEqual(await response.json(), status === 200
                ? { hasPassword: true, googleLinked: false, googleDeletionEnabled: false } : { error: 'UNAVAILABLE' });
            assert.equal(response.headers.get('set-cookie'), null);
        }, enabled, { missingProviderTable: true });
    }
});
