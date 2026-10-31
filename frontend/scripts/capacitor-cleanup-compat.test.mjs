import assert from 'node:assert/strict';
import { readdir } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const require = createRequire(import.meta.url);
const capacitorPackage = require.resolve('@capacitor/cli/package.json');
const capacitorRequire = createRequire(capacitorPackage);
const rimrafPath = capacitorRequire.resolve('rimraf');
const { rimraf } = capacitorRequire('rimraf');
// The CLI's rimraf dependency is temporarily pinned to the fixed glob major.
// Keep these checks until upstream supports a non-vulnerable version directly.
const { glob } = createRequire(rimrafPath)('glob');

async function fixture(t) {
    const base = await realpath(tmpdir());
    const root = await mkdtemp(join(base, 'ludolume-capacitor-compat-'));
    assert.equal(dirname(root), base);
    assert.ok(basename(root).startsWith('ludolume-capacitor-compat-'));
    assert.equal(await realpath(root), root);
    t.after(async () => {
        // Only remove the temporary directory created by this test.
        assert.equal(dirname(resolve(root)), base);
        assert.ok(basename(root).startsWith('ludolume-capacitor-compat-'));
        await rm(root, { recursive: true, force: true });
    });
    return root;
}

test('the installed Capacitor CLI starts and lists the synthetic web project', async t => {
    const root = await fixture(t);
    const sentinel = join(root, 'keep.txt');
    await writeFile(sentinel, 'keep');
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'synthetic-capacitor-compat', version: '1.0.0' }));
    await writeFile(join(root, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.synthetic', appName: 'Synthetic', webDir: 'www' }));
    await mkdir(join(root, 'www'));
    const cli = join(dirname(capacitorPackage), 'bin', 'capacitor');
    const options = { cwd: root, env: { ...process.env, CI: 'true' }, encoding: 'utf8', timeout: 30000 };
    const help = spawnSync(process.execPath, [cli, '--help'], options);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:|Commands:/u);
    const list = spawnSync(process.execPath, [cli, 'ls', 'web'], options);
    assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
    assert.match(list.stdout, /Listing plugins for web/u);
    assert.equal(await readFile(sentinel, 'utf8'), 'keep');
});

test('Capacitor rimraf preserves siblings when deleting literal Windows-style paths', async t => {
    const root = await fixture(t);
    const target = join(root, 'Project files [draft]', 'build');
    const sibling = join(root, 'Project files d', 'build');
    for (const path of [target, sibling]) {
        await mkdir(path, { recursive: true });
        await writeFile(join(path, 'marker.txt'), 'keep');
    }
    assert.ok(target.startsWith(`${root}${sep}`));
    rimraf.sync(target);
    await assert.rejects(readFile(join(target, 'marker.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(join(sibling, 'marker.txt'), 'utf8'), 'keep');
});

test('the migration cleanup pattern is treated as a literal path without glob enabled', async t => {
    const root = await fixture(t);
    const base = join(root, 'node_modules', '@capacitor');
    for (const name of ['!(cli)', 'cli', 'ios']) {
        await mkdir(join(base, name), { recursive: true });
        await writeFile(join(base, name, 'marker.txt'), name);
    }
    // Capacitor currently invokes rimraf without glob options for this path.
    rimraf.sync(join(base, '!(cli)'));
    await assert.rejects(readFile(join(base, '!(cli)', 'marker.txt')), { code: 'ENOENT' });
    for (const name of ['cli', 'ios']) assert.equal(await readFile(join(base, name, 'marker.txt'), 'utf8'), name);
});

test('Capacitor copies Android assets inside a synthetic project without touching siblings', async t => {
    const root = await fixture(t);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'synthetic-capacitor-compat', version: '1.0.0' }));
    await writeFile(join(root, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.synthetic', appName: 'Synthetic', webDir: 'www' }));
    const assets = join(root, 'android', 'app', 'src', 'main', 'assets');
    await mkdir(join(assets, 'public'), { recursive: true });
    await mkdir(join(root, 'www'));
    await writeFile(join(root, 'www', 'index.html'), '<html><body>synthetic</body></html>');
    await writeFile(join(assets, 'public', 'old.txt'), 'replace');
    const sentinel = join(root, 'android', 'app', 'src', 'main', 'keep.txt');
    await writeFile(sentinel, 'keep');
    const cli = join(dirname(capacitorPackage), 'bin', 'capacitor');
    const result = spawnSync(process.execPath, [cli, 'copy', 'android'], {
        cwd: root, env: { ...process.env, CI: 'true' }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await readFile(join(assets, 'public', 'index.html'), 'utf8'), '<html><body>synthetic</body></html>');
    await assert.rejects(readFile(join(assets, 'public', 'old.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(sentinel, 'utf8'), 'keep');
});

test('rimraf glob selection stays within the requested pattern', async t => {
    const root = await fixture(t);
    for (const name of ['remove-one', 'remove-two', 'keep-one']) {
        await mkdir(join(root, name));
        await writeFile(join(root, name, 'marker.txt'), name);
    }
    rimraf.sync('remove-*', { glob: { cwd: root } });
    for (const name of ['remove-one', 'remove-two']) {
        await assert.rejects(readFile(join(root, name, 'marker.txt')), { code: 'ENOENT' });
    }
    assert.equal(await readFile(join(root, 'keep-one', 'marker.txt'), 'utf8'), 'keep-one');
});

test('explicit globbing supports the Capacitor migration extglob without removing the CLI', async t => {
    const root = await fixture(t);
    const base = join(root, 'node_modules', '@capacitor');
    for (const name of ['cli', 'android', 'ios']) {
        await mkdir(join(base, name), { recursive: true });
        await writeFile(join(base, name, 'marker.txt'), name);
    }
    rimraf.sync('node_modules/@capacitor/!(cli)', { glob: { cwd: root } });
    for (const name of ['android', 'ios']) await assert.rejects(readFile(join(base, name, 'marker.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(join(base, 'cli', 'marker.txt'), 'utf8'), 'cli');
});

test('an aborted glob traversal does not continue reading directories', async t => {
    const root = await fixture(t);
    for (const name of ['first', 'second', 'third']) await mkdir(join(root, name, 'nested'), { recursive: true });
    const controller = new AbortController();
    const reason = new Error('synthetic traversal cancelled');
    let reads = 0;
    const fs = { readdir(path, options, callback) {
        reads++;
        readdir(path, options, (error, entries) => {
            if (!controller.signal.aborted) controller.abort(reason);
            callback(error, entries);
        });
    } };
    await assert.rejects(glob('**/*', { cwd: root, signal: controller.signal, fs }), error => error === reason);
    assert.ok(reads > 0, 'the traversal must begin before it is cancelled');
    const readsAtRejection = reads;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(reads, readsAtRejection, 'no new directory reads should start after cancellation');
});
