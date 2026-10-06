import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import type { VerifiedProviderIdentity } from '../auth/providerIdentity';
import { createParentRegistrationFlow, type ParentChallenge, type ParentGrant, type ParentRegistrationPolicy,
    type ParentRegistrationStore } from './parentRegistrationFlow';

const policy: ParentRegistrationPolicy = { version: 'synthetic-1', consentVersion: 'consent-1',
    consentText: 'Synthetic test consent only.', privacyNoticeUrl: 'https://notice.example.test/privacy', countries: ['ZZ'] };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ctx = () => { const accountId = randomUUID(); return { bindingHash: randomBytes(32),
    account: { accountId, userId: 42 }, session: { accountId, sessionId: randomBytes(32).toString('base64url') },
    bindingExpiresAt: null, anonymousCookie: null } as ProviderAuthContext; };
const beginInput = { purpose: 'create-child', clientKey: 'google-web', policyVersion: policy.version,
    consentVersion: policy.consentVersion, privacyNoticeUrl: policy.privacyNoticeUrl,
    country: 'ZZ', adultAttestation: true, guardianAttestation: true, consent: true };

function fixture(selectedPolicy: ParentRegistrationPolicy | undefined = policy) {
    let clock = 1_800_000_000_000;
    const context = ctx();
    const attempts = new Map<string, { value: ParentChallenge; phase: 'pending' | 'verifying' | 'approved' | 'cancelled' | 'used'; grant?: ParentGrant }>();
    const children = new Map<string, { accountId: string; userName: string; scoreVisibility: 'private' }>();
    const calls: string[] = [];
    let identity = { provider: 'google', subject: 'synthetic-parent', email: 'parent@example.test' } as VerifiedProviderIdentity;
    let linked = true;
    let pause: Promise<void> | undefined;
    // This model exercises the service's protocol. It is deliberately test-only,
    // and is not evidence that a production SQL transaction implements the store contract.
    const store: ParentRegistrationStore = { async listChildren() { return []; },
        async begin(value) { calls.push('begin'); attempts.set(value.stateHash.toString('hex'), { value, phase: 'pending' }); return true; },
        async consumeChallenge(state, current) {
            calls.push('consume'); const item = attempts.get(state.toString('hex'));
            if (!item || item.phase !== 'pending' || !item.value.bindingHash.equals(current.bindingHash)) return null;
            item.phase = 'verifying'; return item.value;
        },
        async isLinkedParent() { calls.push('linked'); return linked; },
        async approve(grant) { calls.push('approve'); const item = attempts.get(grant.stateHash.toString('hex'));
            if (!item || item.phase !== 'verifying' || grant.expiresAt <= clock) return false;
            item.phase = 'approved'; item.grant = grant; return true;
        },
        async cancel(state, current) { const item = attempts.get(state.toString('hex'));
            if (item?.value.bindingHash.equals(current.bindingHash) && item.phase !== 'used') item.phase = 'cancelled'; },
        async createChild(grantHash, current, digest, credentials) {
            const item = [...attempts.values()].find(value => value.grant?.grantHash.equals(grantHash));
            if (!item || item.phase !== 'approved' || item.value.operation.purpose !== 'create-child'
                || !item.value.bindingHash.equals(current.bindingHash) || !item.value.policyDigest.equals(digest)
                || item.value.expiresAt <= clock) throw new Error('not authorized');
            item.phase = 'used'; const child = { accountId: randomUUID(), userName: credentials.userName, scoreVisibility: 'private' as const };
            children.set(child.accountId, child); return child;
        },
        async withdrawChild(grantHash, current, digest) {
            const item = [...attempts.values()].find(value => value.grant?.grantHash.equals(grantHash));
            if (!item || item.phase !== 'approved' || item.value.operation.purpose !== 'withdraw-child'
                || !item.value.bindingHash.equals(current.bindingHash) || !item.value.policyDigest.equals(digest)
                || item.value.expiresAt <= clock) throw new Error('not authorized');
            item.phase = 'used'; children.delete(item.value.operation.childAccountId);
        },
    };
    const verifier = { async verify(_provider: unknown, _token: unknown, nonce: string) {
        calls.push('verify'); assert.equal([...attempts.values()].find(value => value.value.nonce === nonce)?.phase, 'verifying');
        if (pause) await pause;
        return { verified: true as const, identity };
    } };
    const clients = { 'google-web': { provider: 'google' as const, verifier }, 'apple-web': { provider: 'apple' as const, verifier } };
    const flow = createParentRegistrationFlow({ policy: selectedPolicy, clients, store, now: () => clock });
    async function approve(input = beginInput) {
        const challenge = await flow.begin(context, input); assert.ok('state' in challenge);
        const result = await flow.complete(context, { state: challenge.state, idToken: 'synthetic-token' });
        assert.ok('grant' in result); return { challenge, result };
    }
    return { flow, store, context, attempts, children, calls, clients, approve,
        advance: (ms: number) => { clock += ms; }, setIdentity: (value: VerifiedProviderIdentity) => { identity = value; },
        setLinked: (value: boolean) => { linked = value; }, pause: (value: Promise<void>) => { pause = value; } };
}

test('closed by default; a reviewed policy is copied rather than mutable through caller references', async () => {
    const f = fixture(); const closed = createParentRegistrationFlow({ clients: f.clients, store: f.store });
    assert.deepEqual(closed.config(), { enabled: false });
    assert.deepEqual(await closed.begin(f.context, beginInput), { error: 'CLOSED' });
    const countries = ['ZZ']; const flow = createParentRegistrationFlow({ policy: { ...policy, countries }, clients: f.clients, store: f.store });
    countries.push('US'); const config = flow.config(); assert.ok(config.enabled); assert.deepEqual(config.countries, ['ZZ']);
});

for (const [name, patch] of Object.entries({ missingAdult: { adultAttestation: undefined }, falseGuardian: { guardianAttestation: false },
    noConsent: { consent: false }, staleConsent: { consentVersion: 'old' }, stalePolicy: { policyVersion: 'old' },
    unknownCountry: { country: 'US' }, childEmail: { email: 'child@example.test' }, unknownClient: { clientKey: '__proto__' } })) {
    test(`begin rejects ${name} before collecting provider credentials`, async () => {
        const f = fixture(); assert.deepEqual(await f.flow.begin(f.context, { ...beginInput, ...patch }), { error: 'INVALID_REQUEST' });
        assert.deepEqual(f.calls, []);
    });
}

test('anonymous, inconsistent session and request-supplied parent identity cannot authorize', async () => {
    const f = fixture(); assert.deepEqual(await f.flow.begin(null, beginInput), { error: 'INVALID_CONTEXT' });
    const changed = { ...f.context, session: { ...f.context.session!, accountId: randomUUID() } } as ProviderAuthContext;
    assert.deepEqual(await f.flow.begin(changed, beginInput), { error: 'INVALID_CONTEXT' });
    assert.deepEqual(await f.flow.begin(f.context, { ...beginInput, parentAccountId: randomUUID() }), { error: 'INVALID_REQUEST' });
});

test('fresh provider proof consumes the challenge first and creates a distinct private child without replacing parent context', async () => {
    const f = fixture(); const before = structuredClone(f.context.account);
    const { result } = await f.approve();
    assert.deepEqual(f.calls, ['begin', 'consume', 'verify', 'linked', 'approve']);
    const child = await f.flow.createChild(f.context, { grant: result.grant, userName: '  nickname  ', password: 'synthetic-only-password' });
    assert.ok('created' in child); assert.equal(child.child.userName, 'nickname'); assert.equal(child.child.scoreVisibility, 'private');
    assert.notEqual(child.child.accountId, before!.accountId); assert.deepEqual(f.context.account, before);
});

test('same challenge concurrent completions verify once; same grant concurrent creations create once', async () => {
    const f = fixture(); const challenge = await f.flow.begin(f.context, beginInput); assert.ok('state' in challenge);
    const results = await Promise.all([1, 2].map(() => f.flow.complete(f.context, { state: challenge.state, idToken: 'token' })));
    assert.equal(results.filter(result => 'grant' in result).length, 1); assert.equal(f.calls.filter(value => value === 'verify').length, 1);
    const approved = results.find(result => 'grant' in result)!; assert.ok('grant' in approved);
    const created = await Promise.all([1, 2].map(() => f.flow.createChild(f.context,
        { grant: approved.grant, userName: 'nickname', password: 'synthetic-only-password' })));
    assert.equal(created.filter(result => 'created' in result).length, 1); assert.equal(f.children.size, 1);
});

test('another session cannot consume a challenge; even a faulty store cannot substitute another parent', async () => {
    const f = fixture(); const challenge = await f.flow.begin(f.context, beginInput); assert.ok('state' in challenge);
    assert.deepEqual(await f.flow.complete(ctx(), { state: challenge.state, idToken: 'token' }), { error: 'INVALID_ATTEMPT' });
    f.attempts.get(hash(challenge.state))!.value = { ...f.attempts.get(hash(challenge.state))!.value, parentAccountId: randomUUID() };
    assert.deepEqual(await f.flow.complete(f.context, { state: challenge.state, idToken: 'token' }), { error: 'INVALID_ATTEMPT' });
    assert.ok(!f.calls.includes('verify'));
});

test('email match never substitutes for a provider linked to the authenticated parent', async () => {
    const f = fixture(); f.setLinked(false); const challenge = await f.flow.begin(f.context, beginInput); assert.ok('state' in challenge);
    assert.deepEqual(await f.flow.complete(f.context, { state: challenge.state, idToken: 'token' }), { error: 'PROVIDER_NOT_LINKED' });
    assert.ok(!f.calls.includes('approve'));
});

test('missing provider-verified contact blocks creation without extending the consumed attempt', async () => {
    const f = fixture(); f.setIdentity({ provider: 'google', subject: 'parent' } as VerifiedProviderIdentity);
    const challenge = await f.flow.begin(f.context, beginInput); assert.ok('state' in challenge);
    assert.deepEqual(await f.flow.complete(f.context, { state: challenge.state, idToken: 'token' }), { error: 'VERIFIED_CONTACT_REQUIRED' });
    assert.deepEqual(await f.flow.complete(f.context, { state: challenge.state, idToken: 'token' }), { error: 'INVALID_ATTEMPT' });
});

test('expiry during provider verification and cancellation during verification cannot produce usable grants', async () => {
    for (const cancelled of [false, true]) {
        const f = fixture(); let resume!: () => void; f.pause(new Promise(resolve => { resume = resolve; }));
        const challenge = await f.flow.begin(f.context, beginInput); assert.ok('state' in challenge);
        const pending = f.flow.complete(f.context, { state: challenge.state, idToken: 'token' });
        await new Promise(resolve => setImmediate(resolve));
        if (cancelled) await f.flow.cancel(f.context, { state: challenge.state }); else f.advance(300_000);
        resume(); assert.deepEqual(await pending, { error: 'INVALID_ATTEMPT' });
    }
});

test('changing consent text invalidates a pending attempt even when its version is unchanged', async () => {
    const f = fixture(); const challenge = await f.flow.begin(f.context, beginInput); assert.ok('state' in challenge);
    const changed = createParentRegistrationFlow({ policy: { ...policy, consentText: 'Changed reviewed text.' }, clients: f.clients, store: f.store });
    assert.deepEqual(await changed.complete(f.context, { state: challenge.state, idToken: 'token' }), { error: 'INVALID_ATTEMPT' });
});

test('notice URL is exposed with consent and binds both pending proof and approved grant', async () => {
    const f = fixture();
    const config = f.flow.config(); assert.ok(config.enabled); assert.equal(config.privacyNoticeUrl, policy.privacyNoticeUrl);
    const approved = await f.approve();
    const pending = await f.flow.begin(f.context, beginInput); assert.ok('state' in pending);
    const changed = createParentRegistrationFlow({ policy: { ...policy, privacyNoticeUrl: 'https://notice.example.test/privacy-v2' },
        clients: f.clients, store: f.store });
    assert.deepEqual(await changed.begin(f.context, beginInput), { error: 'INVALID_REQUEST' }, 'stale displayed notice cannot begin a new approval');
    assert.deepEqual(await changed.complete(f.context, { state: pending.state, idToken: 'token' }), { error: 'INVALID_ATTEMPT' });
    assert.deepEqual(await changed.createChild(f.context, { grant: approved.result.grant, userName: 'nick', password: 'synthetic-password' }), { error: 'UNAVAILABLE' });
    assert.equal(f.children.size, 0);
    assert.throws(() => createParentRegistrationFlow({ policy: { ...policy, privacyNoticeUrl: 'javascript:alert(1)' },
        clients: f.clients, store: f.store }), /Invalid reviewed/u);
});

test('cancelling an approved grant blocks creation; cancelling a consumed grant does not delete its child', async () => {
    const f = fixture(); const first = await f.approve(); await f.flow.cancel(f.context, { state: first.challenge.state });
    assert.ok('error' in await f.flow.createChild(f.context, { grant: first.result.grant, userName: 'nick', password: 'synthetic-password' }));
    const second = await f.approve(); assert.ok('created' in await f.flow.createChild(f.context,
        { grant: second.result.grant, userName: 'nick', password: 'synthetic-password' }));
    await f.flow.cancel(f.context, { state: second.challenge.state }); assert.equal(f.children.size, 1);
});

test('withdrawal needs a separate purpose and exact child; missing email does not prevent consent withdrawal', async () => {
    const f = fixture(); const created = await f.approve();
    const child = await f.flow.createChild(f.context, { grant: created.result.grant, userName: 'nick', password: 'synthetic-password' });
    assert.ok('created' in child);
    assert.ok('error' in await f.flow.withdrawChild(f.context, { grant: created.result.grant, confirmation: 'WITHDRAW AND DELETE' }));
    f.setIdentity({ provider: 'google', subject: 'parent' } as VerifiedProviderIdentity);
    const challenge = await f.flow.begin(f.context, { purpose: 'withdraw-child', childAccountId: child.child.accountId,
        clientKey: 'google-web', confirmation: 'WITHDRAW AND DELETE', policyVersion: policy.version }); assert.ok('state' in challenge);
    const proof = await f.flow.complete(f.context, { state: challenge.state, idToken: 'token' }); assert.ok('grant' in proof);
    assert.deepEqual(await f.flow.withdrawChild(f.context, { grant: proof.grant, confirmation: 'WITHDRAW AND DELETE' }), { deleted: true });
    assert.equal(f.children.size, 0);
});

test('a parent cannot target their own account through child withdrawal; child credentials enforce bcrypt byte limits', async () => {
    const f = fixture(); assert.deepEqual(await f.flow.begin(f.context, { purpose: 'withdraw-child',
        childAccountId: f.context.account!.accountId, clientKey: 'google-web', confirmation: 'WITHDRAW AND DELETE', policyVersion: policy.version }), { error: 'INVALID_REQUEST' });
    const { result } = await f.approve();
    assert.deepEqual(await f.flow.createChild(f.context, { grant: result.grant, userName: 'nick', password: '😀'.repeat(19) }), { error: 'INVALID_REQUEST' });
});

test('US managed creation stays closed without the additional signed-form capability', async () => {
    const f = fixture({ ...policy, countries: ['US'] });
    assert.deepEqual(await f.flow.begin(f.context, { ...beginInput, country: 'US' }), { error: 'CLOSED' });
    assert.equal(f.calls.length, 0);
});

test('signed form endpoints reject anonymous contexts, extra child fields and unsupported country challenges', async () => {
    const f = fixture({ ...policy, countries: ['ZZ', 'US'], signedFormsEnabled: true });
    f.store.requestSignedForm = async () => { throw new Error('must not store unsupported input'); };
    assert.deepEqual(await f.flow.requestSignedForm(null, {}), { error: 'INVALID_CONTEXT' });
    const challenge = await f.flow.begin(f.context, beginInput); assert.ok('state' in challenge);
    assert.deepEqual(await f.flow.requestSignedForm(f.context, { state: challenge.state, idToken: 'token', userName: 'synthetic', childEmail: 'child@example.test' }), { error: 'INVALID_REQUEST' });
    assert.deepEqual(await f.flow.requestSignedForm(f.context, { state: challenge.state, idToken: 'token', userName: 'synthetic' }), { error: 'INVALID_ATTEMPT' });
    assert.equal(f.calls.includes('verify'), false);
});
