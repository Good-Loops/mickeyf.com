import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { AppleAndroidHandoffError, type AppleAndroidHandoffBinding } from './appleAndroidHandoffCrypto';
import { createAppleAndroidHandoffRepository } from './appleAndroidHandoffRepository';

const value = (): AppleAndroidHandoffBinding => ({stateHash:randomBytes(32),bindingHash:randomBytes(32),
    nonce:randomBytes(32).toString('base64url'),clientKey:'apple-android',action:'login',
    accountId:null,userId:null,expiresAt:Date.now()+240_000});
const proof = createHash('sha256').update('synthetic').digest('base64url');
function fixture(failCommit=false,timeout=false) {
    const events:string[]=[];
    const session={
        async query(options:{sql:string}) {
            events.push(options.sql.startsWith('SELECT')?'SELECT':options.sql.split(' ')[0]);
            if(timeout) throw Object.assign(new Error('synthetic-private-driver-value'),{code:'PROTOCOL_SEQUENCE_TIMEOUT'});
            if(options.sql==='COMMIT'&&failCommit)throw new Error('synthetic-private-commit-value');
            if(options.sql.startsWith('SELECT'))return [[{encrypted_credential:Buffer.from('synthetic')}],[]];
            if(options.sql.startsWith('DELETE'))return [{affectedRows:1},[]];
            return [[],[]];
        },
        release(){events.push('release');},destroy(){events.push('destroy');},
        connection:{stream:{destroy(){events.push('stream-destroy');}}},
    };
    const database={async getConnection(){return session as unknown as PoolConnection;}} as Pick<Pool,'getConnection'>;
    const cipher={encrypt(){return Buffer.from('synthetic');},decrypt(){events.push('decrypt');
        return {idToken:'synthetic.id.token',authorizationCode:'synthetic-code'};}};
    return {events,store:createAppleAndroidHandoffRepository(database,cipher)};
}
test('credential decryption occurs only after successful commit and release',async()=>{
    const {events,store}=fixture();
    assert.deepEqual(await store.redeem(value(),proof),{idToken:'synthetic.id.token',authorizationCode:'synthetic-code'});
    assert.deepEqual(events,['START','SELECT','SELECT','DELETE','COMMIT','release','decrypt']);
});
test('uncertain commit cannot decrypt/return a credential and discards the connection',async()=>{
    const {events,store}=fixture(true);
    await assert.rejects(store.redeem(value(),proof),error=>error instanceof AppleAndroidHandoffError
        && !('cause' in error)&&!error.message.includes('private'));
    assert.equal(events.includes('decrypt'),false);
    assert.equal(events.includes('release'),false);
    assert.equal(events.filter(event=>event==='destroy').length,1);
});
test('timed-out command discards socket immediately without queuing transaction cleanup',async()=>{
    const {events,store}=fixture(false,true);
    await assert.rejects(store.redeem(value(),proof),AppleAndroidHandoffError);
    assert.deepEqual(events,['START','destroy','stream-destroy']);
});
test('invalid bindings fail before borrowing a connection',async()=>{
    const {events,store}=fixture();
    await assert.rejects(store.redeem({...value(),nonce:'private-invalid-value'},proof),AppleAndroidHandoffError);
    assert.deepEqual(events,[]);
});
