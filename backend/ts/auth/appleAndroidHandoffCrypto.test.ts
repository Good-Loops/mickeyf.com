import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { AppleTokenEncryptionSettings } from '../accounts/appleTokenRepository';
import { AppleAndroidHandoffError, createAppleAndroidHandoffCrypto,
    type AppleAndroidHandoffBinding } from './appleAndroidHandoffCrypto';

const time = 1_800_000_000_000;
const original = randomBytes(32);
const settings = { clientId: 'com.example.web', activeKeyId: 'current', encryptionKeys: { current: original } };
const credential = { idToken: 'synthetic.header.signature', authorizationCode: 'synthetic-code' };
const binding = (): AppleAndroidHandoffBinding => ({ stateHash: randomBytes(32), bindingHash: randomBytes(32),
    nonce: randomBytes(32).toString('base64url'), clientKey: 'apple-android', action: 'login',
    accountId: null, userId: null, expiresAt: time + 240_000 });
const cipher = () => createAppleAndroidHandoffCrypto(settings, () => time);

test('round trip is nondeterministic and contains no plaintext provider credentials', () => {
    const box = cipher();
    const context = binding();
    const first = box.encrypt(context, credential);
    assert.deepEqual(box.decrypt(context, first), credential);
    assert.notDeepEqual(first, box.encrypt(context, credential));
    assert.equal(first.includes(Buffer.from(credential.idToken)), false);
    assert.equal(first.includes(Buffer.from(credential.authorizationCode)), false);
});

test('each bound field, envelope tampering, and another Services ID fail closed', () => {
    const context = binding();
    const box = cipher();
    const envelope = box.encrypt(context, credential);
    for (const change of [{stateHash:randomBytes(32)}, {bindingHash:randomBytes(32)},
        {nonce:randomBytes(32).toString('base64url')}, {action:'signup' as const}, {expiresAt:context.expiresAt - 1},
        {action:'delete' as const,accountId:randomUUID(),userId:1}]) {
        assert.throws(() => box.decrypt({...context,...change}, envelope), AppleAndroidHandoffError);
    }
    for (const index of [0, 1, 3, envelope.length - 1]) {
        const modified = Buffer.from(envelope); modified[index] ^= 1;
        assert.throws(() => box.decrypt(context, modified), AppleAndroidHandoffError);
    }
    assert.throws(() => createAppleAndroidHandoffCrypto({...settings,clientId:'other.example.web'},()=>time)
        .decrypt(context,envelope), AppleAndroidHandoffError);
});

test('rotation can read the previous key; missing/invalid keys and wrong purposes cannot', () => {
    const context = binding();
    const encrypted = cipher().encrypt(context, credential);
    const rotated = createAppleAndroidHandoffCrypto({ ...settings, activeKeyId:'next',
        encryptionKeys:{current:original,next:randomBytes(32)} },()=>time);
    assert.deepEqual(rotated.decrypt(context,encrypted),credential);
    assert.throws(() => createAppleAndroidHandoffCrypto({...settings,encryptionKeys:{current:randomBytes(32)}},()=>time)
        .decrypt(context,encrypted),AppleAndroidHandoffError);
    const offset = 2 + encrypted[1];
    const direct = createCipheriv('aes-256-gcm', original, encrypted.subarray(offset,offset+12));
    const rawPayload = Buffer.from(JSON.stringify(credential));
    const data = Buffer.concat([direct.update(rawPayload),direct.final()]);
    const wrongPurpose = Buffer.concat([encrypted.subarray(0,offset+12),direct.getAuthTag(),data]);
    assert.throws(() => cipher().decrypt(context,wrongPurpose),AppleAndroidHandoffError);
    const invalidSettings: Partial<AppleTokenEncryptionSettings>[] = [{activeKeyId:'absent'},{activeKeyId:'bad\n'}, {encryptionKeys:{}},
        {encryptionKeys:{current:Buffer.alloc(31)}}, {clientId:'bad\n'}];
    for(const override of invalidSettings) {
        assert.throws(() => createAppleAndroidHandoffCrypto({...settings,...override}),AppleAndroidHandoffError);
    }
});

test('expired, over-five-minute, malformed credential and invalid account bindings are rejected without causes', () => {
    const context = binding();
    for (const expiresAt of [time,time-1,time+300_001,Number.NaN]) {
        assert.throws(()=>cipher().encrypt({...context,expiresAt},credential),AppleAndroidHandoffError);
    }
    const encrypted=cipher().encrypt(context,credential);
    assert.throws(()=>createAppleAndroidHandoffCrypto(settings,()=>context.expiresAt).decrypt(context,encrypted),AppleAndroidHandoffError);
    for(const invalid of [{idToken:'not-jwt',authorizationCode:'secret'}, {...credential,authorizationCode:'secret\n'},
        {...credential,authorizationCode:'x'.repeat(4097)}, {...credential,idToken:'x'.repeat(16385)},
        {...credential,extra:'private'}]) {
        assert.throws(()=>cipher().encrypt(context,invalid),error=>error instanceof AppleAndroidHandoffError
            && !('cause' in error) && !error.message.includes('secret'));
    }
    assert.throws(()=>cipher().encrypt({...context,action:'link',accountId:null,userId:null},credential),AppleAndroidHandoffError);
    assert.throws(()=>cipher().encrypt({...context,accountId:randomUUID(),userId:1},credential),AppleAndroidHandoffError);
    assert.deepEqual(cipher().decrypt({...context,action:'delete',accountId:'123e4567-e89b-42d3-a456-426614174000',userId:1},
        cipher().encrypt({...context,action:'delete',accountId:'123e4567-e89b-42d3-a456-426614174000',userId:1},credential)),credential);
});

test('key material is captured privately without mutating the existing keyring', () => {
    const key=randomBytes(32); const copy=Buffer.from(key);
    const box=createAppleAndroidHandoffCrypto({...settings,encryptionKeys:{current:key}},()=>time);
    assert.deepEqual(key,copy);
    key.fill(0);
    const context=binding();
    assert.deepEqual(box.decrypt(context,box.encrypt(context,credential)),credential);
});
