import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const read = path => JSON.parse(readFileSync(path, 'utf8'));

// npm lock paths mirror Node resolution: nested node_modules first, then parents.
function resolvePackage(packages, from, name) {
    let parent = from;
    for (;;) {
        const candidate = `${parent ? `${parent}/` : ''}node_modules/${name}`;
        if (packages[candidate]) return candidate;
        const nested = parent.lastIndexOf('/node_modules/');
        if (nested >= 0) parent = parent.slice(0, nested);
        else if (parent) parent = '';
        else return null;
    }
}

function reachableWebsitePackages(packages) {
    const visited = new Set(), pending = [''];
    while (pending.length) {
        const key = pending.pop();
        if (visited.has(key)) continue;
        visited.add(key);
        const entry = packages[key];
        const dependencies = { ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies,
            ...(key === '' ? entry.devDependencies : {}) };
        if (key === '') {
            delete dependencies['@capacitor/cli'];
            dependencies.xcode = '3.0.1';
        }
        for (const name of Object.keys(dependencies)) {
            const resolved = resolvePackage(packages, key, name);
            // Uninstalled optional or peer packages do not contribute lock entries.
            if (resolved) pending.push(resolved);
        }
    }
    return visited;
}

function assertLockRoot(lock, manifest) {
    assert.equal(lock.lockfileVersion, 3, 'Expected npm lockfile version 3');
    assert.equal(lock.name, manifest.name, 'Lock name differs from manifest');
    assert.equal(lock.version, manifest.version, 'Lock version differs from manifest');
    assert.ok(lock.packages && lock.packages[''], 'Lock root is missing');
    const root = lock.packages[''];
    for (const field of ['name', 'version', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'engines']) {
        assert.deepEqual(root[field], manifest[field], `Lock root ${field} differs from manifest`);
    }
}

export function verifyWebsiteBuild(originalManifest, websiteManifest, originalLock, websiteLock) {
    const expected = structuredClone(originalManifest);
    assert.ok(expected.devDependencies['@capacitor/cli'], 'Expected the native-only CLI in the original manifest');
    delete expected.devDependencies['@capacitor/cli'];
    // This native-config test dependency was previously supplied transitively by the CLI.
    expected.devDependencies.xcode = '3.0.1';
    assert.deepEqual(websiteManifest, expected, 'Website manifest must omit the native CLI and retain its xcode test dependency');
    assertLockRoot(originalLock, originalManifest);
    assertLockRoot(websiteLock, websiteManifest);

    const source = originalLock.packages, scoped = websiteLock.packages;
    assert.equal(source['node_modules/xcode']?.version, '3.0.1', 'The direct xcode test dependency must match the original lock');
    assert.ok(!scoped['node_modules/@capacitor/cli'], 'Native CLI must not be in the website lock');
    for (const [path, entry] of Object.entries(scoped)) {
        if (!path) continue;
        assert.ok(source[path], `Website lock adds an unreviewed package: ${path}`);
        // npm can annotate a retained package as a peer when the CLI is removed.
        // Every substantive field, including version, source, integrity, platform,
        // dependency graph and install flags, must still match the original lock.
        const { peer: _sourcePeer, ...sourceEntry } = source[path];
        const { peer: _scopedPeer, ...websiteEntry } = entry;
        assert.deepEqual(websiteEntry, sourceEntry, `Website lock package differs: ${path}`);
    }
    const reachable = reachableWebsitePackages(source);
    for (const [path, entry] of Object.entries(source)) {
        if (!path || scoped[path]) continue;
        assert.equal(entry.dev, true, `Website lock omits a non-development package: ${path}`);
        assert.ok(!reachable.has(path), `Website lock omits a package reachable from website dependencies: ${path}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    verifyWebsiteBuild(read('frontend/package.json'), read('.github/website-build/package.json'),
        read('frontend/package-lock.json'), read('.github/website-build/package-lock.json'));
}
