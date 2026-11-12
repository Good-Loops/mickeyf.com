import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Environment, SignedDataVerifier } from '@apple/app-store-server-library';
import jwt from 'jsonwebtoken';
import { appleAppStoreRoots } from './appleAppStoreRoots';
import { readAppStoreConsentNotification } from './appStoreConsentNotification';
import { createAppStoreSignedDataVerifier } from './appStoreSignedDataVerifier';

test('uses the published Apple root certificates and rejects unsigned test environments', () => {
    const roots = appleAppStoreRoots();
    assert.deepEqual(roots.map(root => createHash('sha256').update(root).digest('hex')), [
        'c2b9b042dd57830e7d117dac55ac8ae19407d38e41d88f3215bc3a890444a050',
        '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179',
    ]);
    assert.ok(roots.every(root => new X509Certificate(root).ca));
    assert.throws(() => createAppStoreSignedDataVerifier({ environment: 'sandbox', bundleId: 'com.example.app', appAppleId: 1 }));
    assert.throws(() => createAppStoreSignedDataVerifier({ environment: 'production', bundleId: 'com.example.app' }));
    assert.throws(() => createAppStoreSignedDataVerifier({ environment: 'production', bundleId: 'bad', appAppleId: 1 }));
    assert.throws(() => createAppStoreSignedDataVerifier({ environment: 'xcode' as 'sandbox', bundleId: 'com.example.app' }));
});

test('the configured Apple verifier rejects a forged notification with the correct app and environment', async () => {
    const verifier = createAppStoreSignedDataVerifier({ environment: 'production', bundleId: 'com.example.app', appAppleId: 123 });
    const forged = jwt.sign({ notificationType: 'RESCIND_CONSENT', notificationUUID: '6a45449e-988e-4a66-9968-211e92b3331c',
        signedDate: 1_800_000_000_000, appData: { bundleId: 'com.example.app', appAppleId: 123,
            environment: 'Production', signedAppTransactionInfo: 'forged' } }, 'fictional-key', { algorithm: 'HS256' });
    assert.deepEqual(await readAppStoreConsentNotification(forged, verifier), { kind: 'invalid' });
});

test('Apple library verifies its signed public fixture and rejects tampering and the wrong bundle', async () => {
    // Public test-only root and notification from Apple's MIT-licensed server library,
    // commit b71d9c70aa4a4a5efea258d530f50733a7916af3. This is not a production trust anchor.
    const directory = join(__dirname, 'fixtures', 'apple');
    const root = readFileSync(join(directory, 'test-ca.der'));
    const signed = readFileSync(join(directory, 'test-notification.jws'), 'utf8').trim();
    // Historical fixture: use the signed date rather than current-time OCSP checks.
    const verifier = new SignedDataVerifier([root], false, Environment.SANDBOX, 'com.example');
    assert.deepEqual(await readAppStoreConsentNotification(signed, verifier), { kind: 'test' });
    const parts = signed.split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    assert.deepEqual(await readAppStoreConsentNotification(parts.join('.'), verifier), { kind: 'invalid' });
    const wrongApp = new SignedDataVerifier([root], false, Environment.SANDBOX, 'com.other');
    assert.deepEqual(await readAppStoreConsentNotification(signed, wrongApp), { kind: 'invalid' });
});
