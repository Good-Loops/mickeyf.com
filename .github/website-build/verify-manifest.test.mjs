import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifyWebsiteBuild } from './verify-manifest.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const originals = [read('../../frontend/package.json'), read('./package.json'),
    read('../../frontend/package-lock.json'), read('./package-lock.json')];
const fixture = () => originals.map(value => structuredClone(value));

test('actual website lock permits the removed native CLI and the existing direct xcode dependency', () => {
    const values = fixture();
    assert.doesNotThrow(() => verifyWebsiteBuild(...values));
    assert.equal(values[1].devDependencies.xcode, values[2].packages['node_modules/xcode'].version);
    assert.ok(!values[3].packages['node_modules/@capacitor/cli']);
});

for (const field of ['version', 'integrity', 'resolved', 'dependencies']) {
    test(`website lock rejects drift in retained package ${field}`, () => {
        const values = fixture();
        values[2].packages['node_modules/vite'][field] = field === 'dependencies' ? { changed: '1.0.0' } : 'changed';
        assert.throws(() => verifyWebsiteBuild(...values), /Website lock package differs: node_modules\/vite/u);
    });
}

test('website lock rejects omission of a runtime package', () => {
    const values = fixture();
    delete values[3].packages['node_modules/react'];
    assert.throws(() => verifyWebsiteBuild(...values), /omits a non-development package/u);
});

test('website lock rejects omission of a reachable development package', () => {
    const values = fixture();
    delete values[3].packages['node_modules/vite'];
    assert.throws(() => verifyWebsiteBuild(...values), /omits a package reachable from website dependencies/u);
});

test('website lock rejects omission of a reachable nested dependency', () => {
    const values = fixture();
    delete values[3].packages['node_modules/vite/node_modules/fdir'];
    assert.throws(() => verifyWebsiteBuild(...values), /omits a package reachable from website dependencies/u);
});

test('website lock rejects a package absent from the original lock', () => {
    const values = fixture();
    values[3].packages['node_modules/unreviewed'] = { version: '1.0.0', dev: true };
    assert.throws(() => verifyWebsiteBuild(...values), /adds an unreviewed package/u);
});

test('website lock rejects xcode version drift or removal', () => {
    const values = fixture();
    values[2].packages['node_modules/xcode'].version = '4.0.0';
    assert.throws(() => verifyWebsiteBuild(...values), /direct xcode test dependency must match/u);
    const withoutXcode = fixture();
    delete withoutXcode[3].packages['node_modules/xcode'];
    assert.throws(() => verifyWebsiteBuild(...withoutXcode), /reachable from website dependencies/u);
});

test('website lock rejects lock root drift but accepts npm peer annotations', () => {
    const values = fixture();
    values[3].packages[''].devDependencies.vite = '^1.0.0';
    assert.throws(() => verifyWebsiteBuild(...values), /Lock root devDependencies differs/u);
    const peerOnly = fixture();
    peerOnly[3].packages['node_modules/vite'].peer = !peerOnly[2].packages['node_modules/vite'].peer;
    assert.doesNotThrow(() => verifyWebsiteBuild(...peerOnly));
});

for (const field of ['optionalDependencies', 'peerDependencies']) {
    test(`website lock rejects unrecorded root ${field}`, () => {
        const values = fixture();
        values[0][field] = { example: '^1.0.0' };
        values[1][field] = { example: '^1.0.0' };
        assert.throws(() => verifyWebsiteBuild(...values), new RegExp(`Lock root ${field} differs`, 'u'));
    });
}
