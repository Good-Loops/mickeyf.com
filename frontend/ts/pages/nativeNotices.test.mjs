import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = new URL('../../../', import.meta.url);
const read = async (name) => readFile(new URL(name, root));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const normalizedSha = (bytes) => sha(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')));

test('native notices are current with the platform lockfiles', async () => {
    const manifest = JSON.parse(await read('frontend/native-notices-manifest.json'));
    assert.equal(normalizedSha(await read('frontend/android/app/gradle.lockfile')), manifest.android_lockfile_sha256);
    assert.equal(normalizedSha(await read('frontend/ios/App/Podfile.lock')), manifest.ios_lockfile_sha256);
    assert.equal(sha(await read('frontend/public/native-third-party-notices.txt')), manifest.notices_sha256);
});
