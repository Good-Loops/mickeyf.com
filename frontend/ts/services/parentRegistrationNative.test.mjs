import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createNativeApiFetch } from './nativeApiFetch.ts';
import { createAuthApi } from './authApi.ts';
import { createParentRegistrationApi } from './parentRegistrationApi.ts';

const origin = 'https://mickeyf-org-j7yuum4tiq-uc.a.run.app';
const prefix = '/auth/parent-registration/';
const random = () => randomBytes(32).toString('base64url');
const expected = ['GET config', 'POST begin', 'POST complete', 'POST cancel', 'POST children', 'POST withdraw', 'POST children/list', 'POST family/delete', 'GET scores/config', 'POST scores/status', 'POST scores/publish', 'POST scores/withdraw']
    .map(route => route.replace(' ', ` ${prefix}`));

for (const [platform, source] of [
    ['Android', '../../android/app/src/main/java/com/mickeyf/app/LudolumeApiPolicy.java'],
    ['iOS', '../../ios/App/App/LudolumeApiPlugin.swift'],
]) test(`${platform} parent creation and management requests fit the actual native route contract`, async () => {
    // Uses the real API/transport and each source allowlist; not an OS bridge or live-provider test.
    const native = await readFile(new URL(source, import.meta.url), 'utf8');
    const routes = new Set([...native.matchAll(/"((?:GET|POST) \/auth\/parent-registration\/[^"\n]+)"/g)].map(match => match[1]));
    assert.deepEqual([...routes].sort(), [...expected].sort());
    const policy = { enabled: true, creationEnabled: true, policyVersion: 'test-policy', consentVersion: 'test-consent', consentText: 'Synthetic consent.', privacyNoticeUrl: 'https://notice.example.test/privacy', countries: ['ZZ'] };
    const child = { accountId: randomUUID(), userName: 'private-child', scoreVisibility: 'private' };
    const seen = new Set(); let purpose;
    const transport = createNativeApiFetch(async request => {
        assert.deepEqual(Object.keys(request).sort(), request.method === 'GET' ? ['method', 'url'] : ['body', 'method', 'url']);
        assert.ok(request.url.startsWith(origin + prefix));
        const route = `${request.method} ${request.url.slice(origin.length)}`;
        assert.ok(routes.has(route), `${platform} would reject ${route} before networking`); seen.add(route);
        const path = request.url.slice((origin + prefix).length);
        let value;
        if (path === 'config') value = policy;
        else if (path === 'scores/config') { const {countries,creationEnabled,...publicPolicy}=policy; value=publicPolicy; }
        else if (path === 'scores/status') value = {visibility:'private',canPublish:true};
        else if (path === 'scores/publish') value = {visibility:'public'};
        else if (path === 'scores/withdraw') value = {visibility:'private'};
        else if (path === 'family/delete') value = {deleted:true};
        else if (path === 'begin') { purpose = JSON.parse(request.body).purpose; value = { state: random(), nonce: random(), expiresInSeconds: 300 }; }
        else if (path === 'complete') value = { grant: random(), purpose, expiresInSeconds: 250 };
        else if (path === 'children') value = { created: true, child };
        else if (path === 'children/list') value = { children: [child] };
        else if (path === 'withdraw') value = { deleted: true };
        else value = { cancelled: true };
        return { status: 200, body: JSON.stringify(value) };
    });
    const api = createParentRegistrationApi(origin, transport);
    const auth = createAuthApi(origin, transport);
    const config = await api.config();
    const challenge = await api.begin(config, 'synthetic-native', { country: 'ZZ', adultAttestation: true, guardianAttestation: true, consent: true });
    const approval = await api.complete(challenge.state, 'synthetic-token');
    assert.deepEqual(await api.createChild(approval.grant, child.userName, 'synthetic-password'), child);
    assert.deepEqual(await api.listChildren(), [{ accountId: child.accountId, userName: child.userName }]);
    const withdrawal = await api.beginWithdrawal(config, 'synthetic-native', child.accountId);
    const proof = await api.complete(withdrawal.state, 'synthetic-token');
    await api.withdraw(proof.grant); await api.cancel(challenge.state);
    const scores = await api.scoreConfig();
    assert.deepEqual(await api.scoreStatus(child.accountId),{visibility:'private',canPublish:true});
    const choice = await api.beginScorePublication(scores,'synthetic-native',child.accountId);
    const chosen = await api.complete(choice.state,'synthetic-token'); await api.publishScores(chosen.grant);
    await api.withdrawScores(child.accountId);
    const family=await api.beginFamilyDeletion(config,'synthetic-native',[child.accountId]);
    const familyProof=await api.complete(family.state,'synthetic-token');
    await auth.deleteFamilyRequest(familyProof.grant,[child.accountId]);
    assert.deepEqual([...seen].sort(), [...expected].sort());
    for (const path of ['begin', 'complete', 'cancel', 'children', 'withdraw', 'children/list','family/delete','scores/status','scores/publish','scores/withdraw']) assert.ok(!routes.has(`GET ${prefix}${path}`));
    assert.ok(!routes.has(`POST ${prefix}config`)); assert.ok(!routes.has(`POST ${prefix}children/delete`));
});
