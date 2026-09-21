import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { issueSessionToken } from '../security/sessionPolicy';
import type { Pool } from 'mysql2/promise';
import type { ProviderAccount, ProviderLinkResult, ProviderAccountCreationResult } from '../accounts/providerAccountRepository';
import { AccountDeletionPendingError } from '../accounts/accountDeletionRepository';
import { createProviderAuthContextReader, type ProviderAuthContext } from './providerAuthContext';
import { createProviderAuthFlow, type ProviderAuthClient, type ProviderAuthFlowDependencies } from './providerAuthFlow';
import type { ProviderAttempt, ProviderAttemptAction } from './providerAttemptRepository';
import type { IdentityProvider } from './providerIdentity';
import { createProviderTokenVerifier, PROVIDER_TOKEN_MAX_LENGTH, type ProviderTokenVerificationResult } from './providerTokenVerifier';

const secret = 'provider-flow-tests-only-session-secret';
const origin = 'capacitor://localhost';
const account: ProviderAccount = { userId: 7, userName: 'player', accountId: '123e4567-e89b-42d3-a456-426614174000' };
const otherAccountId = '123e4567-e89b-42d3-a456-426614174001';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = 1_800_000_000;
const password = ' correct horse ';
const hash = (value: string) => createHash('sha256').update(value).digest();

function signedToken(nonce: string, provider: IdentityProvider = 'google', extra: Record<string, unknown> = {}): string {
    return jwt.sign({
        iss: provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com',
        aud: `${provider}-audience`, sub: 'opaque-provider-subject', nonce, iat: now - 10, exp: now + 300, ...extra,
    }, key.privateKey, { algorithm: 'RS256', keyid: 'test-key' });
}

async function trustedContext(currentAccount?: ProviderAccount, bindingByte = 1) {
    const database = {
        async query(_query: unknown, values: unknown[]) {
            assert.equal(values[0], currentAccount?.userId);
            return [[currentAccount]];
        },
    } as unknown as Pick<Pool, 'query'>;
    const request = {
        method: 'POST', headers: { origin, 'content-type': 'application/json' }, cookies: {},
        signedCookies: { session: currentAccount ? issueSessionToken(currentAccount, secret).token
            : ['provider', 'v1', Date.now(), Buffer.alloc(32, bindingByte).toString('base64url')].join(':') },
    };
    const context = await createProviderAuthContextReader({ database, sessionSecret: secret, allowedOrigins: [origin] })(request);
    assert(context);
    return context;
}

async function fixture(currentAccount?: ProviderAccount, newActions = false, appleActions = false) {
    const context = await trustedContext(currentAccount);
    const events: string[] = [];
    const pending = new Map<string, ProviderAttempt>();
    const created: ProviderAttempt[] = [];
    const controls: {
        failAt?: string;
        busy?: boolean;
        consumeGate?: Promise<void>;
        verificationGate?: Promise<void>;
        verification?: ProviderTokenVerificationResult;
        foundAccount: ProviderAccount | null;
        linkResult: ProviderLinkResult;
        creation: ProviderAccountCreationResult;
        deletion: 'deleted' | 'invalid-password' | 'not-found' | 'pending';
    } = { foundAccount: account, linkResult: 'linked', creation: { created: true, account }, deletion: 'deleted' };
    function step(name: string) {
        events.push(name);
        if (controls.failAt === name) throw new Error('sensitive token, password, SQL and connection details');
    }
    const actualVerifier = createProviderTokenVerifier({ googleAudience: 'google-audience', appleAudience: 'apple-audience' }, {
        now: () => now * 1000,
        fetch: async () => new Response(JSON.stringify({ keys: [{
            ...key.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig',
        }] })),
    });
    const verifiedNonces: string[] = [];
    const linkedTargets: unknown[][] = [];
    const createdAccounts: unknown[][] = [];
    const deletedAccounts: unknown[][] = [];
    const verifier = {
        async verify(provider: IdentityProvider, token: unknown, nonce: string) {
            step('verify');
            verifiedNonces.push(nonce);
            if (controls.verificationGate) await controls.verificationGate;
            return controls.verification ?? actualVerifier.verify(provider, token, nonce);
        },
    };
    const clients: Record<string, ProviderAuthClient> = {
        'google-native': { provider: 'google', verifier }, 'apple-native': { provider: 'apple', verifier },
        'google-web': { provider: 'google', verifier },
        'apple-ios': { provider: 'apple', verifier, signupEnabled: appleActions, deletionEnabled: appleActions },
    };
    Object.setPrototypeOf(clients, { inherited: clients['google-native'] });
    const dependencies: ProviderAuthFlowDependencies = {
        clients,
        attempts: {
            async create(attempt) {
                step('create');
                if (controls.busy) return 'busy';
                for (const [state, existing] of pending) {
                    if (existing.bindingHash.equals(attempt.bindingHash)) pending.delete(state);
                }
                const stored = { ...attempt, stateHash: Buffer.from(attempt.stateHash), bindingHash: Buffer.from(attempt.bindingHash) };
                created.push(stored);
                pending.set(stored.stateHash.toString('hex'), stored);
                return 'created';
            },
            async consume(stateHash, bindingHash, clientKey, action) {
                step('consume');
                if (controls.consumeGate) await controls.consumeGate;
                const state = stateHash.toString('hex');
                const stored = pending.get(state);
                if (!stored || !stored.bindingHash.equals(bindingHash) || stored.clientKey !== clientKey || stored.action !== action) return null;
                pending.delete(state);
                step('committed');
                return { nonce: stored.nonce, accountId: stored.accountId, userId: stored.userId };
            },
        },
        accounts: {
            async find(identity) {
                step('find');
                assert.equal(identity.subject, 'opaque-provider-subject');
                return controls.foundAccount;
            },
            async link(target, suppliedPassword, identity, session) {
                step('link');
                linkedTargets.push([target, suppliedPassword, identity, session]);
                return controls.linkResult;
            },
            async create(identity, userName) {
                step('signup'); createdAccounts.push([identity, userName]);
                return controls.creation;
            },
            async delete(target, identity, session) {
                step('delete'); deletedAccounts.push([target, identity, session]);
                if (controls.deletion === 'pending') throw new AccountDeletionPendingError(new Error('private failure'));
                return controls.deletion;
            },
        },
    };
    const flow = createProviderAuthFlow({ ...dependencies, enabled: true, signupEnabled: newActions, deletionEnabled: newActions });
    async function challenge(action: ProviderAttemptAction = currentAccount ? 'link' : 'login') {
        const clientKey = action === 'signup' || action === 'delete' ? 'google-web' : 'google-native';
        const result = await flow.begin(context, { clientKey, action });
        assert(result.ok);
        const input = { clientKey, action, state: result.state, idToken: signedToken(result.nonce, 'google',
            action === 'signup' ? { email: 'new-player@gmail.com', email_verified: true } : {}),
            ...(action === 'link' ? { password } : {}), ...(action === 'signup' ? { userName: ' new-player ' } : {}),
            ...(action === 'delete' ? { confirmation: 'DELETE' } : {}) };
        events.length = 0;
        return { result, input };
    }
    return { flow, context, events, pending, created, controls, dependencies, clients, actualVerifier, verifiedNonces,
        linkedTargets, createdAccounts, deletedAccounts, challenge };
}

test('plain request data cannot satisfy the trusted context type', () => {
    const plain = { bindingHash: Buffer.alloc(32), account: null, session: null,
        bindingExpiresAt: null, anonymousCookie: null };
    // @ts-expect-error Only the verified-cookie reader constructs the private context brand.
    const untrusted: ProviderAuthContext = plain;
    assert.equal(untrusted, plain);
});

test('default-disabled flow rejects begin and completion without calling any port', async () => {
    const f = await fixture();
    const disabled = createProviderAuthFlow(f.dependencies);
    assert.deepEqual(await disabled.begin(null, null), { ok: false, reason: 'UNAVAILABLE' });
    assert.deepEqual(await disabled.complete(null, null), { ok: false, reason: 'UNAVAILABLE' });
    assert.deepEqual(f.events, []);
});

test('begin accepts only an exact configured client/action request and the corresponding context', async () => {
    const f = await fixture();
    for (const input of [null, [], { clientKey: 'missing', action: 'login' }, { clientKey: '__proto__', action: 'login' },
        { clientKey: 'inherited', action: 'login' }, { clientKey: 'google-native', action: 'signup' },
        { clientKey: 'google-native', action: 'login', audience: 'submitted-audience' }]) {
        assert.deepEqual(await f.flow.begin(f.context, input), { ok: false, reason: 'INVALID_REQUEST' });
    }
    assert.deepEqual(await f.flow.begin(null, { clientKey: 'google-native', action: 'login' }), { ok: false, reason: 'INVALID_CONTEXT' });
    assert.deepEqual(await f.flow.begin(f.context, { clientKey: 'google-native', action: 'link' }), { ok: false, reason: 'INVALID_CONTEXT' });
    assert.deepEqual(await f.flow.begin(await trustedContext(account), { clientKey: 'google-native', action: 'login' }), { ok: false, reason: 'INVALID_CONTEXT' });
    assert.deepEqual(f.events, []);
});

test('challenge returns independent random state/nonce and persists only the hashed state and server binding', async () => {
    const f = await fixture();
    const first = (await f.challenge()).result;
    const second = (await f.challenge()).result;
    for (const value of [first.state, first.nonce, second.state, second.nonce]) {
        assert.match(value, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(Buffer.from(value, 'base64url').length, 32);
    }
    assert.equal(new Set([first.state, first.nonce, second.state, second.nonce]).size, 4);
    assert.ok(first.expiresInSeconds > 0 && first.expiresInSeconds <= 300);
    assert.deepEqual(f.created[0], { stateHash: hash(first.state), bindingHash: f.context.bindingHash,
        nonce: first.nonce, clientKey: 'google-native', action: 'login', userId: null, accountId: null });
    assert.equal(f.pending.size, 1);
    f.controls.busy = true;
    assert.deepEqual(await f.flow.begin(f.context, { clientKey: 'google-native', action: 'login' }), { ok: false, reason: 'BUSY' });
});

test('challenge lifetime is bounded by the remaining anonymous cookie lifetime', async t => {
    const f = await fixture();
    assert.ok(f.context.bindingExpiresAt);
    let clock = f.context.bindingExpiresAt - 123_400;
    t.mock.method(Date, 'now', () => clock);
    const result = await f.flow.begin(f.context, { clientKey: 'google-native', action: 'login' });
    assert.ok(result.ok);
    assert.equal(result.expiresInSeconds, 123);
    clock = f.context.bindingExpiresAt - 999;
    assert.deepEqual(await f.flow.begin(f.context, { clientKey: 'google-native', action: 'login' }),
        { ok: false, reason: 'BUSY' });
    const linking = await fixture(account);
    const challenge = await linking.challenge();
    assert.equal(challenge.result.expiresInSeconds, 300);
});

test('malformed completion and incompatible context are rejected without consuming a valid challenge', async () => {
    const f = await fixture();
    const { input } = await f.challenge();
    for (const invalid of [{ ...input, state: 'short' }, { ...input, idToken: '' },
        { ...input, idToken: 'x'.repeat(PROVIDER_TOKEN_MAX_LENGTH + 1) }, { ...input, expectedNonce: 'caller-proof' },
        { ...input, accountId: account.accountId }, { ...input, clientKey: 'missing' }]) {
        assert.deepEqual(await f.flow.complete(f.context, invalid), { ok: false, reason: 'INVALID_REQUEST' });
    }
    assert.deepEqual(await f.flow.complete(null, input), { ok: false, reason: 'INVALID_CONTEXT' });
    assert.deepEqual(await f.flow.complete(await trustedContext(account), input), { ok: false, reason: 'INVALID_CONTEXT' });
    assert.deepEqual(f.events, []);
    assert.equal(f.pending.size, 1);
    const linking = await fixture(account);
    const link = await linking.challenge();
    assert.deepEqual(await linking.flow.complete(linking.context, { ...link.input, password: 42 }), { ok: false, reason: 'INVALID_REQUEST' });
    assert.deepEqual(linking.events, []);
});

test('completion waits for committed consumption before verifying the stored nonce and finding the account', async () => {
    const f = await fixture();
    const { result, input } = await f.challenge();
    let release!: () => void;
    f.controls.consumeGate = new Promise<void>(resolve => { release = resolve; });
    const completing = f.flow.complete(f.context, input);
    assert.deepEqual(f.events, ['consume']);
    release();
    assert.deepEqual(await completing, { ok: true, type: 'account-verified', account });
    assert.deepEqual(f.events, ['consume', 'committed', 'verify', 'find']);
    assert.deepEqual(f.verifiedNonces, [result.nonce]);
});

test('concurrent completions and later replay perform verification and account lookup only once', async () => {
    const f = await fixture();
    const { input } = await f.challenge();
    const results = await Promise.all([f.flow.complete(f.context, input), f.flow.complete(f.context, input)]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.deepEqual(results.find(result => !result.ok), { ok: false, reason: 'INVALID_ATTEMPT' });
    assert.deepEqual(await f.flow.complete(f.context, input), { ok: false, reason: 'INVALID_ATTEMPT' });
    assert.equal(f.events.filter(event => event === 'verify').length, 1);
    assert.equal(f.events.filter(event => event === 'find').length, 1);
});

test('another browser binding or configured client cannot consume the original attempt', async () => {
    const f = await fixture();
    const { input } = await f.challenge();
    assert.deepEqual(await f.flow.complete(await trustedContext(undefined, 2), input), { ok: false, reason: 'INVALID_ATTEMPT' });
    assert.deepEqual(await f.flow.complete(f.context, { ...input, clientKey: 'apple-native' }), { ok: false, reason: 'INVALID_ATTEMPT' });
    assert.deepEqual(f.events, ['consume', 'consume']);
    assert.equal(f.pending.size, 1);
    assert.equal((await f.flow.complete(f.context, input)).ok, true);
});

test('invalid tokens, provider outages and wrong passwords burn their challenge', async () => {
    for (const failure of ['token', 'outage', 'password'] as const) {
        const f = await fixture(failure === 'password' ? account : undefined);
        const { input } = await f.challenge();
        if (failure === 'token') input.idToken = 'not-a-token';
        if (failure === 'outage') f.controls.verification = { verified: false, reason: 'PROVIDER_UNAVAILABLE' };
        if (failure === 'password') f.controls.linkResult = 'invalid-password';
        const reason = failure === 'token' ? 'INVALID_PROVIDER_TOKEN' : failure === 'outage' ? 'UNAVAILABLE' : 'INVALID_PASSWORD';
        assert.deepEqual(await f.flow.complete(f.context, input), { ok: false, reason });
        assert.deepEqual(await f.flow.complete(f.context, input), { ok: false, reason: 'INVALID_ATTEMPT' });
        assert.equal(f.pending.size, 0);
        assert.equal(f.events.filter(event => event === 'verify').length, 1);
    }
});

test('an unlinked provider returns NOT_LINKED without invoking linking or creating an account', async () => {
    const f = await fixture();
    f.controls.foundAccount = null;
    const { input } = await f.challenge();
    assert.deepEqual(await f.flow.complete(f.context, input), { ok: false, reason: 'NOT_LINKED' });
    assert.deepEqual(f.events, ['consume', 'committed', 'verify', 'find']);
    assert.deepEqual(f.linkedTargets, []);
});

test('explicit linking passes the server-resolved UUID target, unchanged password, verified identity and session proof', async () => {
    const f = await fixture(account);
    const { input } = await f.challenge();
    assert.deepEqual(await f.flow.complete(f.context, input), { ok: true, type: 'linked' });
    assert.deepEqual(f.events, ['consume', 'committed', 'verify', 'link']);
    assert.deepEqual(f.linkedTargets, [[{ userId: account.userId, accountId: account.accountId }, password,
        { provider: 'google', subject: 'opaque-provider-subject' }, f.context.session]]);
    assert.equal(f.created[0].accountId, account.accountId);
    assert.equal(f.created[0].userId, account.userId);
});

test('linking requires session proof and forwards it after provider verification for the final live-session check', async () => {
    const f = await fixture(account);
    const noSession = { ...f.context, session: null };
    assert.deepEqual(await f.flow.begin(noSession, { clientKey: 'google-native', action: 'link' }),
        { ok: false, reason: 'INVALID_CONTEXT' });
    assert.deepEqual(f.events, []);
    const { input } = await f.challenge();
    assert.deepEqual(await f.flow.complete(noSession, input), { ok: false, reason: 'INVALID_CONTEXT' });
    assert.equal(f.pending.size, 1);
    let release!: () => void;
    f.controls.verificationGate = new Promise<void>(resolve => { release = resolve; });
    const completing = f.flow.complete(f.context, input);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.events, ['consume', 'committed', 'verify']);
    assert.deepEqual(f.linkedTargets, []);
    f.controls.linkResult = 'not-found';
    release();
    assert.deepEqual(await completing, { ok: false, reason: 'ACCOUNT_GONE' });
    assert.deepEqual(f.linkedTargets[0][3], f.context.session);
    assert.deepEqual(await f.flow.complete(f.context, input), { ok: false, reason: 'INVALID_ATTEMPT' });
});

test('a refreshed anonymous binding after login/logout cannot complete an earlier anonymous attempt', async () => {
    const f = await fixture();
    const { input } = await f.challenge();
    const authenticated = await trustedContext(account);
    assert.deepEqual(await f.flow.complete(authenticated, input), { ok: false, reason: 'INVALID_CONTEXT' });
    const afterLogout = await trustedContext(undefined, 3);
    assert.notDeepEqual(afterLogout.bindingHash, f.context.bindingHash);
    assert.deepEqual(await f.flow.complete(afterLogout, input), { ok: false, reason: 'INVALID_ATTEMPT' });
    assert.deepEqual(f.events, ['consume']);
    assert.equal(f.pending.size, 1);
});

test('a consumed attempt with a different stored UUID or numeric ID cannot reach verification or linking', async () => {
    for (const replacement of [{ accountId: otherAccountId }, { userId: account.userId + 1 }]) {
        const f = await fixture(account);
        const { input } = await f.challenge();
        const stateHash = hash(input.state).toString('hex');
        f.pending.set(stateHash, { ...f.pending.get(stateHash)!, ...replacement });
        assert.deepEqual(await f.flow.complete(f.context, input), { ok: false, reason: 'INVALID_ATTEMPT' });
        assert.deepEqual(f.events, ['consume', 'committed']);
        assert.equal(f.pending.size, 0);
    }
});

test('a verifier result for another provider is rejected before account operations', async () => {
    const f = await fixture();
    const { result, input } = await f.challenge();
    f.controls.verification = await f.actualVerifier.verify('apple', signedToken(result.nonce, 'apple'), result.nonce);
    assert(f.controls.verification.verified);
    assert.deepEqual(await f.flow.complete(f.context, input), { ok: false, reason: 'INVALID_PROVIDER_TOKEN' });
    assert.deepEqual(f.events, ['consume', 'committed', 'verify']);
});

test('exceptions from every port produce only a sanitized unavailable result', async () => {
    for (const failAt of ['create', 'consume', 'verify', 'find', 'link']) {
        const f = await fixture(failAt === 'link' ? account : undefined);
        if (failAt === 'create') {
            f.controls.failAt = failAt;
            assert.deepEqual(await f.flow.begin(f.context, { clientKey: 'google-native', action: 'login' }), { ok: false, reason: 'UNAVAILABLE' });
        } else {
            const { input } = await f.challenge();
            f.controls.failAt = failAt;
            assert.deepEqual(await f.flow.complete(f.context, input), { ok: false, reason: 'UNAVAILABLE' });
            if (failAt !== 'consume') assert.equal(f.pending.size, 0);
        }
    }
});

test('client configuration captures own keys and is unaffected by later entry replacement', async () => {
    const f = await fixture();
    const replacement: ProviderAuthClient = { provider: 'apple', verifier: {
        async verify() { throw new Error('replacement verifier must not run'); },
    } };
    f.clients['google-native'] = replacement;
    f.clients['late-client'] = replacement;
    assert.deepEqual(await f.flow.begin(f.context, { clientKey: 'late-client', action: 'login' }), { ok: false, reason: 'INVALID_REQUEST' });
    assert.deepEqual(await f.flow.begin(f.context, { clientKey: 'inherited', action: 'login' }), { ok: false, reason: 'INVALID_REQUEST' });
    const { input } = await f.challenge();
    assert.deepEqual(await f.flow.complete(f.context, input), { ok: true, type: 'account-verified', account });
    assert.throws(() => createProviderAuthFlow({ ...f.dependencies, clients: { 'Bad.Client': replacement } }), /Invalid provider client configuration/);
});

test('signup and deletion require their separate opt-ins and exact Google web client before attempt work', async () => {
    const anonymous = await fixture();
    const authenticated = await fixture(account);
    assert.deepEqual(await anonymous.flow.begin(anonymous.context, { clientKey: 'google-web', action: 'signup' }),
        { ok: false, reason: 'UNAVAILABLE' });
    assert.deepEqual(await authenticated.flow.begin(authenticated.context, { clientKey: 'google-web', action: 'delete' }),
        { ok: false, reason: 'ACCOUNT_DELETION_UNAVAILABLE' });
    assert.deepEqual(anonymous.events, []);
    assert.deepEqual(authenticated.events, []);
    const enabled = await fixture(undefined, true);
    for (const action of ['signup', 'delete']) {
        for (const clientKey of ['google-native', 'apple-native']) {
            assert.deepEqual(await enabled.flow.begin(enabled.context, { clientKey, action }),
                { ok: false, reason: 'INVALID_REQUEST' });
        }
    }
    assert.deepEqual(await enabled.flow.begin(enabled.context, { clientKey: 'google-web', action: 'delete' }),
        { ok: false, reason: 'INVALID_CONTEXT' });
    assert.deepEqual(await enabled.flow.begin(await trustedContext(account), { clientKey: 'google-web', action: 'signup' }),
        { ok: false, reason: 'INVALID_CONTEXT' });
});

test('explicit signup creates only after purpose-bound consumption and verified authoritative email', async () => {
    const f = await fixture(undefined, true);
    const { result, input } = await f.challenge('signup');
    assert.deepEqual(await f.flow.complete(f.context, input), { ok: true, type: 'account-verified', account });
    assert.deepEqual(f.events, ['consume', 'committed', 'verify', 'signup']);
    assert.deepEqual(f.createdAccounts, [[{ provider: 'google', subject: 'opaque-provider-subject',
        email: 'new-player@gmail.com' }, 'new-player']]);
    assert.equal(f.created[0].action, 'signup');
    assert.equal(f.created[0].accountId, null);
    assert.deepEqual(f.verifiedNonces, [result.nonce]);
    assert.deepEqual(await f.flow.complete(f.context, input), { ok: false, reason: 'INVALID_ATTEMPT' });
});

test('signup rejects malformed metadata and never accepts email, password or account proof from the client', async () => {
    const f = await fixture(undefined, true);
    const { input } = await f.challenge('signup');
    for (const userName of [undefined, null, '', ' ', 'a'.repeat(65), 'bad\u0000name']) {
        assert.deepEqual(await f.flow.complete(f.context, { ...input, userName }), { ok: false, reason: 'INVALID_USERNAME' });
    }
    for (const extra of [{ email: 'attacker@gmail.com' }, { password: 'not-needed' }, { accountId: account.accountId }, { rememberMe: true }]) {
        assert.deepEqual(await f.flow.complete(f.context, { ...input, ...extra }), { ok: false, reason: 'INVALID_REQUEST' });
    }
    assert.deepEqual(f.events, []);
    input.idToken = signedToken(f.created[0].nonce, 'google', { email: 'external@example.com', email_verified: true });
    assert.deepEqual(await f.flow.complete(f.context, input), { ok: false, reason: 'INVALID_EMAIL' });
    assert.deepEqual(f.events, ['consume', 'committed', 'verify']);
});

test('signup email and username conflicts never become implicit login or linking and keep failures sanitized', async () => {
    for (const reason of ['DUPLICATE_USER', 'INVALID_USERNAME', 'INVALID_EMAIL'] as const) {
        const f = await fixture(undefined, true);
        f.controls.foundAccount = null;
        f.controls.creation = { created: false, reason };
        const { input } = await f.challenge('signup');
        assert.deepEqual(await f.flow.complete(f.context, input), { ok: false, reason });
        assert.deepEqual(f.events, ['consume', 'committed', 'verify', 'signup', ...(reason === 'DUPLICATE_USER' ? ['find'] : [])]);
        assert.equal(f.linkedTargets.length, 0);
    }
    const f = await fixture(undefined, true);
    const { input } = await f.challenge('signup');
    f.controls.failAt = 'signup';
    assert.deepEqual(await f.flow.complete(f.context, input), { ok: false, reason: 'UNAVAILABLE' });
});

test('Google entry signs in a known subject without username collection or account creation', async () => {
    const f = await fixture(undefined, true);
    const started = await f.flow.begin(f.context, { clientKey: 'google-web', action: 'login' });
    assert.ok(started.ok);
    f.events.length = 0;
    assert.deepEqual(await f.flow.complete(f.context, { clientKey: 'google-web', action: 'login',
        state: started.state, idToken: signedToken(started.nonce) }), { ok: true, type: 'account-verified', account });
    assert.deepEqual(f.events, ['consume', 'committed', 'verify', 'find']);
    assert.equal(f.createdAccounts.length, 0);
});

test('new Google entry authorizes one bound signup continuation without another provider exchange', async () => {
    const f = await fixture(undefined, true);
    f.controls.foundAccount = null;
    const started = await f.flow.begin(f.context, { clientKey: 'google-web', action: 'login' });
    assert.ok(started.ok);
    const login = { clientKey: 'google-web', action: 'login', state: started.state,
        idToken: signedToken(started.nonce, 'google', { email: 'new-player@gmail.com', email_verified: true }) };
    f.events.length = 0;
    const next = await f.flow.complete(f.context, login);
    assert.ok(next.ok && next.type === 'signup-required');
    assert.notEqual(next.state, started.state);
    assert.equal(next.nonce, started.nonce);
    assert.ok(next.expiresInSeconds > 0 && next.expiresInSeconds <= started.expiresInSeconds);
    assert.deepEqual(f.events, ['consume', 'committed', 'verify', 'find', 'create']);
    assert.equal(f.createdAccounts.length, 0);
    const signup = { ...login, action: 'signup', state: next.state, userName: 'new-player' };
    assert.deepEqual(await f.flow.complete(await trustedContext(undefined, 2), signup),
        { ok: false, reason: 'INVALID_ATTEMPT' });
    assert.deepEqual(await f.flow.complete(f.context, { ...login, state: next.state }),
        { ok: false, reason: 'INVALID_ATTEMPT' });
    assert.deepEqual(await f.flow.complete(f.context, signup), { ok: true, type: 'account-verified', account });
    assert.deepEqual(f.verifiedNonces, [started.nonce, started.nonce]);
    assert.equal(f.createdAccounts.length, 1);
    assert.deepEqual(await f.flow.complete(f.context, signup), { ok: false, reason: 'INVALID_ATTEMPT' });
    assert.deepEqual(await f.flow.complete(f.context, login), { ok: false, reason: 'INVALID_ATTEMPT' });
});

test('Google continuation fails closed for disabled signup, missing email, exhausted cookie lifetime and storage failure', async () => {
    for (const failure of ['disabled', 'email', 'expired', 'busy', 'invalid-token'] as const) {
        const f = await fixture(undefined, failure !== 'disabled');
        f.controls.foundAccount = null;
        const started = await f.flow.begin(f.context, { clientKey: 'google-web', action: 'login' });
        assert.ok(started.ok);
        if (failure === 'busy') f.controls.busy = true;
        const context = failure === 'expired' ? { ...f.context, bindingExpiresAt: Date.now() } : f.context;
        const result = await f.flow.complete(context, { clientKey: 'google-web', action: 'login', state: started.state,
            idToken: failure === 'invalid-token' ? 'invalid-token' : signedToken(started.nonce, 'google',
                failure === 'email' ? {} : { email: 'new-player@gmail.com', email_verified: true }) });
        assert.deepEqual(result, { ok: false, reason: { disabled: 'NOT_LINKED', email: 'INVALID_EMAIL',
            expired: 'INVALID_ATTEMPT', busy: 'BUSY', 'invalid-token': 'INVALID_PROVIDER_TOKEN' }[failure] });
        assert.equal(f.createdAccounts.length, 0);
        assert.equal(f.linkedTargets.length, 0);
    }
});

test('concurrent signup resolves only the already-created verified subject, never an email match', async () => {
    for (const reason of ['ALREADY_LINKED', 'DUPLICATE_USER'] as const) {
        const f = await fixture(undefined, true);
        f.controls.creation = { created: false, reason };
        const { input } = await f.challenge('signup');
        assert.deepEqual(await f.flow.complete(f.context, input), { ok: true, type: 'account-verified', account });
        assert.deepEqual(f.events, ['consume', 'committed', 'verify', 'signup', 'find']);
        assert.equal(f.linkedTargets.length, 0);
        const missing = await f.challenge('signup');
        f.controls.foundAccount = null;
        assert.deepEqual(await f.flow.complete(f.context, missing.input), { ok: false, reason });
    }
});

test('login and signup purposes cannot be swapped to authorize account creation', async () => {
    const f = await fixture(undefined, true);
    const result = await f.flow.begin(f.context, { clientKey: 'google-web', action: 'login' });
    assert.ok(result.ok);
    f.events.length = 0;
    const input = { action: 'signup', clientKey: 'google-web', state: result.state, userName: 'new-player',
        idToken: signedToken(result.nonce, 'google', { email: 'new-player@gmail.com', email_verified: true }) };
    assert.deepEqual(await f.flow.complete(f.context, input), { ok: false, reason: 'INVALID_ATTEMPT' });
    assert.deepEqual(f.events, ['consume']);
    assert.equal(f.pending.size, 1);
});

test('Google deletion requires exact confirmation, fresh purpose-bound token and the current live session proof', async () => {
    const f = await fixture(account, true);
    const { input, result } = await f.challenge('delete');
    assert.deepEqual(await f.flow.complete(f.context, { ...input, confirmation: 'delete' }), { ok: false, reason: 'INVALID_REQUEST' });
    assert.deepEqual(await f.flow.complete({ ...f.context, session: null }, input), { ok: false, reason: 'INVALID_CONTEXT' });
    assert.deepEqual(f.events, []);
    assert.deepEqual(await f.flow.complete(f.context, input), { ok: true, type: 'deleted' });
    assert.deepEqual(f.events, ['consume', 'committed', 'verify', 'delete']);
    assert.deepEqual(f.deletedAccounts, [[{ userId: account.userId, accountId: account.accountId },
        { provider: 'google', subject: 'opaque-provider-subject' }, f.context.session]]);
    assert.deepEqual(f.verifiedNonces, [result.nonce]);
    assert.equal(f.created[0].action, 'delete');
    assert.deepEqual(await f.flow.complete(f.context, input), { ok: false, reason: 'INVALID_ATTEMPT' });
});

test('Google deletion rejects an old token, mismatched identity, removed account and uncertain journal outcome', async () => {
    for (const [deletion, reason] of [['invalid-password', 'INVALID_PROVIDER_TOKEN'], ['not-found', 'ACCOUNT_GONE'],
        ['pending', 'ACCOUNT_DELETION_PENDING']] as const) {
        const f = await fixture(account, true);
        f.controls.deletion = deletion;
        const { input } = await f.challenge('delete');
        assert.deepEqual(await f.flow.complete(f.context, input), { ok: false, reason });
    }
    const f = await fixture(account, true);
    const { input } = await f.challenge('delete');
    input.idToken = signedToken('a'.repeat(43));
    assert.deepEqual(await f.flow.complete(f.context, input), { ok: false, reason: 'INVALID_PROVIDER_TOKEN' });
    assert.deepEqual(f.deletedAccounts, []);
    const fresh = await f.challenge('delete');
    f.controls.failAt = 'delete';
    assert.deepEqual(await f.flow.complete(f.context, fresh.input), { ok: false, reason: 'ACCOUNT_DELETION_UNAVAILABLE' });
});

test('global Google signup/deletion switches never enable native Apple account mutations', async () => {
    const anonymous = await fixture(undefined, true);
    const authenticated = await fixture(account, true);
    assert.deepEqual(await anonymous.flow.begin(anonymous.context, { clientKey: 'apple-ios', action: 'signup' }),
        { ok: false, reason: 'UNAVAILABLE' });
    assert.deepEqual(await authenticated.flow.begin(authenticated.context, { clientKey: 'apple-ios', action: 'delete' }),
        { ok: false, reason: 'ACCOUNT_DELETION_UNAVAILABLE' });
    assert.deepEqual(anonymous.events, []);
    assert.deepEqual(authenticated.events, []);
    anonymous.controls.foundAccount = null;
    const started = await anonymous.flow.begin(anonymous.context, { clientKey: 'apple-ios', action: 'login' });
    assert.ok(started.ok);
    assert.deepEqual(await anonymous.flow.complete(anonymous.context, { clientKey: 'apple-ios', action: 'login',
        state: started.state, idToken: signedToken(started.nonce, 'apple', { email: 'player@example.com', email_verified: true }) }),
    { ok: false, reason: 'NOT_LINKED' });
    assert.deepEqual(anonymous.createdAccounts, []);
});

test('opted-in native Apple entry creates only through a single-use username continuation with signed relay email', async () => {
    const f = await fixture(undefined, true, true);
    f.controls.foundAccount = null;
    const started = await f.flow.begin(f.context, { clientKey: 'apple-ios', action: 'login' });
    assert.ok(started.ok);
    const login = { clientKey: 'apple-ios', action: 'login', state: started.state,
        idToken: signedToken(started.nonce, 'apple', { email: 'new-player@privaterelay.appleid.com', email_verified: 'true' }) };
    f.events.length = 0;
    const next = await f.flow.complete(f.context, login);
    assert.ok(next.ok && next.type === 'signup-required');
    assert.notEqual(next.state, started.state);
    assert.equal(next.nonce, started.nonce);
    assert.deepEqual(f.events, ['consume', 'committed', 'verify', 'find', 'create']);
    assert.deepEqual(f.createdAccounts, []);
    const signup = { ...login, action: 'signup', state: next.state, userName: ' new-player ' };
    for (const extra of [{ email: 'untrusted@example.com' }, { name: 'untrusted name' }, { password: 'unused' }]) {
        assert.deepEqual(await f.flow.complete(f.context, { ...signup, ...extra }), { ok: false, reason: 'INVALID_REQUEST' });
    }
    assert.deepEqual(await f.flow.complete(await trustedContext(undefined, 2), signup), { ok: false, reason: 'INVALID_ATTEMPT' });
    assert.deepEqual(await f.flow.complete(f.context, { ...signup, clientKey: 'google-web' }), { ok: false, reason: 'INVALID_ATTEMPT' });
    assert.deepEqual(await f.flow.complete(f.context, { ...login, state: next.state }), { ok: false, reason: 'INVALID_ATTEMPT' });
    assert.deepEqual(await f.flow.complete(f.context, signup), { ok: true, type: 'account-verified', account });
    assert.deepEqual(f.createdAccounts, [[{ provider: 'apple', subject: 'opaque-provider-subject',
        email: 'new-player@privaterelay.appleid.com' }, 'new-player']]);
    assert.deepEqual(f.verifiedNonces, [started.nonce, started.nonce]);
    assert.deepEqual(await f.flow.complete(f.context, signup), { ok: false, reason: 'INVALID_ATTEMPT' });
    assert.deepEqual(await f.flow.complete(f.context, login), { ok: false, reason: 'INVALID_ATTEMPT' });
    assert.deepEqual(f.linkedTargets, []);
});

test('native Apple new signup needs signed verified email while existing subject login does not', async () => {
    for (const extra of [{}, { email: '', email_verified: true }, { email: 'player@example.com', email_verified: false }]) {
        const f = await fixture(undefined, true, true);
        for (const known of [false, true]) {
            f.controls.foundAccount = known ? account : null;
            const started = await f.flow.begin(f.context, { clientKey: 'apple-ios', action: 'login' });
            assert.ok(started.ok);
            assert.deepEqual(await f.flow.complete(f.context, { clientKey: 'apple-ios', action: 'login', state: started.state,
                idToken: signedToken(started.nonce, 'apple', extra) }), known
                ? { ok: true, type: 'account-verified', account } : { ok: false, reason: 'INVALID_EMAIL' });
        }
        const signup = await f.flow.begin(f.context, { clientKey: 'apple-ios', action: 'signup' });
        assert.ok(signup.ok);
        assert.deepEqual(await f.flow.complete(f.context, { clientKey: 'apple-ios', action: 'signup', state: signup.state,
            userName: 'new-player', idToken: signedToken(signup.nonce, 'apple', extra) }), { ok: false, reason: 'INVALID_EMAIL' });
        assert.deepEqual(f.createdAccounts, []);
    }
});

test('opted-in native Apple deletion requires fresh subject proof and the current session, not an email', async () => {
    for (const failure of ['none', 'token', 'subject', 'missing', 'journal'] as const) {
        const f = await fixture(account, true, true);
        const started = await f.flow.begin(f.context, { clientKey: 'apple-ios', action: 'delete' });
        assert.ok(started.ok);
        const input = { clientKey: 'apple-ios', action: 'delete', state: started.state, confirmation: 'DELETE',
            idToken: signedToken(failure === 'token' ? 'a'.repeat(43) : started.nonce, 'apple') };
        if (failure === 'subject') f.controls.deletion = 'invalid-password';
        if (failure === 'missing') f.controls.deletion = 'not-found';
        if (failure === 'journal') f.controls.deletion = 'pending';
        assert.deepEqual(await f.flow.complete(f.context, { ...input, confirmation: 'delete' }), { ok: false, reason: 'INVALID_REQUEST' });
        assert.deepEqual(await f.flow.complete({ ...f.context, session: null }, input), { ok: false, reason: 'INVALID_CONTEXT' });
        assert.deepEqual(await f.flow.complete(f.context, input), failure === 'none' ? { ok: true, type: 'deleted' }
            : { ok: false, reason: { token: 'INVALID_PROVIDER_TOKEN', subject: 'INVALID_PROVIDER_TOKEN',
                missing: 'ACCOUNT_GONE', journal: 'ACCOUNT_DELETION_PENDING' }[failure] });
        if (failure !== 'token') assert.deepEqual(f.deletedAccounts, [[{ userId: account.userId, accountId: account.accountId },
            { provider: 'apple', subject: 'opaque-provider-subject' }, f.context.session]]);
        else assert.deepEqual(f.deletedAccounts, []);
        assert.deepEqual(await f.flow.complete(f.context, input), { ok: false, reason: 'INVALID_ATTEMPT' });
    }
});
