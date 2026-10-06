import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { watch } from 'chokidar';
import {
    createRebuildQueue,
    documentationPaths,
    isDocumentationPath,
    runDocumentationBuild,
    startDocumentationWatcher,
} from './watch-docs.mjs';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fakeChild() {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
        child.signalCode = 'SIGTERM';
        child.emit('close', null, 'SIGTERM');
        return true;
    };
    return child;
}

function fakeFileWatcher() {
    const watcher = new EventEmitter();
    watcher.close = async () => {};
    return watcher;
}

test('debounces a burst into one build without building on startup', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let builds = 0;
    const queue = createRebuildQueue(() => { builds++; });
    assert.equal(builds, 0);
    for (let index = 0; index < 20; index++) queue.request();
    context.mock.timers.tick(399);
    await setImmediate();
    assert.equal(builds, 0);
    context.mock.timers.tick(1);
    await setImmediate();
    assert.equal(builds, 1);
    await queue.stop();
});

test('changes during a slow build coalesce into exactly one subsequent build', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const builds = [];
    const queue = createRebuildQueue(() => {
        const build = deferred();
        builds.push(build);
        return build.promise;
    });
    queue.request();
    context.mock.timers.tick(400);
    await setImmediate();
    for (let index = 0; index < 20; index++) {
        queue.request();
        context.mock.timers.tick(400);
    }
    await setImmediate();
    assert.equal(builds.length, 1);
    builds[0].resolve();
    await setImmediate();
    assert.equal(builds.length, 2);
    builds[1].resolve();
    await setImmediate();
    assert.equal(builds.length, 2);
    await queue.stop();
});

test('waits for the quiet period if a build finishes before the debounce timer', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const first = deferred();
    let builds = 0;
    const queue = createRebuildQueue(() => ++builds === 1 ? first.promise : undefined);
    queue.request();
    context.mock.timers.tick(400);
    await setImmediate();
    queue.request();
    first.resolve();
    await setImmediate();
    assert.equal(builds, 1);
    context.mock.timers.tick(400);
    await setImmediate();
    assert.equal(builds, 2);
    await queue.stop();
});

test('a failed build reports once and can recover on a later change', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const errors = [];
    let builds = 0;
    const queue = createRebuildQueue(() => {
        if (++builds === 1) throw new Error('fixture failure');
    }, { onError: (error) => errors.push(error.message) });
    queue.request();
    context.mock.timers.tick(400);
    await setImmediate();
    context.mock.timers.tick(10000);
    await setImmediate();
    assert.deepEqual(errors, ['fixture failure']);
    assert.equal(builds, 1);
    queue.request();
    context.mock.timers.tick(400);
    await setImmediate();
    assert.equal(builds, 2);
    await queue.stop();
});

test('stop drops queued work, ignores later events and waits for an active build', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const active = deferred();
    let builds = 0;
    const queue = createRebuildQueue(() => { builds++; return active.promise; });
    queue.request();
    context.mock.timers.tick(400);
    await setImmediate();
    queue.request();
    let stopped = false;
    const stopping = queue.stop().then(() => { stopped = true; });
    queue.request();
    context.mock.timers.tick(10000);
    await setImmediate();
    assert.equal(stopped, false);
    active.resolve();
    await stopping;
    assert.equal(stopped, true);
    assert.equal(builds, 1);
});

test('a rejected build does not lose a change queued while it was running', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const first = deferred();
    const errors = [];
    let builds = 0;
    const queue = createRebuildQueue(() => ++builds === 1 ? first.promise : undefined, {
        onError: (error) => errors.push(error.message),
    });
    queue.request();
    context.mock.timers.tick(400);
    await setImmediate();
    queue.request();
    context.mock.timers.tick(400);
    first.reject(new Error('fixture rejection'));
    await setImmediate();
    assert.deepEqual(errors, ['fixture rejection']);
    assert.equal(builds, 2);
    await queue.stop();
});

test('stop before debounce prevents a build', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let builds = 0;
    const queue = createRebuildQueue(() => { builds++; });
    queue.request();
    await queue.stop();
    context.mock.timers.tick(1000);
    await setImmediate();
    assert.equal(builds, 0);
});

test('build runner invokes npm through Node without a shell and propagates exit failures', async () => {
    const child = fakeChild();
    let invocation;
    const building = runDocumentationBuild('C:/fixture with spaces/npm-cli.js', {
        cwd: 'C:/fixture with spaces/repository',
        spawnProcess: (...args) => { invocation = args; return child; },
    });
    assert.equal(invocation[0], process.execPath);
    assert.deepEqual(invocation[1], ['C:/fixture with spaces/npm-cli.js', 'run', 'docs']);
    assert.equal(invocation[2].cwd, 'C:/fixture with spaces/repository');
    assert.equal(invocation[2].shell, undefined);
    assert.equal(invocation[2].windowsHide, true);
    const failed = assert.rejects(building, /exit 2/);
    child.emit('close', 2, null);
    await failed;
});

test('build spawn errors reject rather than hanging the queue', async () => {
    const child = fakeChild();
    const building = runDocumentationBuild('/fixture/npm-cli.js', { spawnProcess: () => child });
    const failed = assert.rejects(building, /fixture spawn failure/);
    child.emit('error', new Error('fixture spawn failure'));
    await failed;
});

test('watcher filters file events and shuts down without a new build', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const fileWatcher = fakeFileWatcher();
    const buildChild = fakeChild();
    const invocations = [];
    const errors = [];
    let watched;
    const watcher = startDocumentationWatcher({
        npmCli: '/fixture/npm-cli.js',
        watchFiles: (...args) => { watched = args; return fileWatcher; },
        spawnProcess: (...args) => { invocations.push(args); return buildChild; },
        report: () => {},
        reportError: (error) => errors.push(error),
    });
    assert.deepEqual(watched[0], documentationPaths);
    assert.equal(watched[1].ignoreInitial, true);
    assert.equal(watched[1].ignored('frontend/ts/data.json', { isFile: () => true }), true);
    assert.equal(watched[1].ignored('frontend/ts/nested', { isFile: () => false }), false);
    fileWatcher.emit('all', 'change', 'frontend/ts/data.json');
    fileWatcher.emit('all', 'change', 'docs/types/generated.html');
    context.mock.timers.tick(400);
    await setImmediate();
    assert.equal(invocations.length, 0);
    fileWatcher.emit('all', 'change', 'frontend/ts/nested/component.tsx');
    fileWatcher.emit('all', 'add', 'backend/ts/another.ts');
    context.mock.timers.tick(400);
    await setImmediate();
    assert.equal(invocations.length, 1);
    const stopping = watcher.stop();
    buildChild.emit('close', 0, null);
    await stopping;
    assert.equal(await watcher.done, 0);
    assert.deepEqual(errors, []);
});

test('watcher failure exits nonzero without attempting a build', async () => {
    const fileWatcher = fakeFileWatcher();
    const errors = [];
    const watcher = startDocumentationWatcher({
        npmCli: '/fixture/npm-cli.js',
        watchFiles: () => fileWatcher,
        spawnProcess: () => { throw new Error('Unexpected build'); },
        reportError: (error) => errors.push(error),
    });
    fileWatcher.emit('error', new Error('fixture filesystem failure'));
    assert.equal(await watcher.done, 1);
    assert.match(errors[0], /fixture filesystem failure/);
});

test('stop waits for the file watcher to close and closes it once', async () => {
    const fileWatcher = fakeFileWatcher();
    const closed = deferred();
    let closes = 0;
    fileWatcher.close = () => { closes++; return closed.promise; };
    const watcher = startDocumentationWatcher({
        npmCli: '/fixture/npm-cli.js',
        watchFiles: () => fileWatcher,
    });
    let stopped = false;
    const stopping = watcher.stop().then(() => { stopped = true; });
    await setImmediate();
    assert.equal(stopped, false);
    assert.equal(watcher.stop(), watcher.stop());
    closed.resolve();
    await stopping;
    assert.equal(stopped, true);
    assert.equal(await watcher.done, 0);
    assert.equal(closes, 1);
});

test('file selection preserves the previous paths and TypeScript extensions', () => {
    for (const path of ['typedoc.merge.json', 'docs-src/index.md', 'docs-src/typedoc.css',
        'docs-src/assets/image.png', 'frontend/ts/file.ts', 'frontend/ts/nested/file.tsx',
        'backend/ts/nested/file.ts']) assert.equal(isDocumentationPath(path), true, path);
    for (const path of ['frontend/ts/data.json', 'frontend/ts/file.js', 'backend/ts/file.tsx',
        'frontend/other.ts', 'docs/types/file.html', '../outside.ts']) {
        assert.equal(isDocumentationPath(path), false, path);
    }
});

test('real file watcher ignores initial and unrelated files, then rebuilds for edits and removal',
    { timeout: 10000 }, async (context) => {
        const cwd = await mkdtemp(join(tmpdir(), 'ludolume-docs-watch-'));
        await mkdir(join(cwd, 'frontend/ts/nested'), { recursive: true });
        const source = join(cwd, 'frontend/ts/nested/source.ts');
        await writeFile(source, 'initial');
        let fileWatcher;
        let builds = 0;
        const watcher = startDocumentationWatcher({
            cwd, npmCli: '/fixture/npm-cli.js', report: () => {},
            watchFiles: (...args) => { fileWatcher = watch(...args); return fileWatcher; },
            spawnProcess: () => {
                builds++;
                const child = fakeChild();
                void setImmediate().then(() => child.emit('close', 0, null));
                return child;
            },
        });
        context.after(async () => {
            await watcher.stop();
            assert.ok(cwd.startsWith(join(tmpdir(), 'ludolume-docs-watch-')));
            await rm(cwd, { recursive: true, force: true });
        });
        await new Promise(resolve => fileWatcher.once('ready', resolve));
        await writeFile(join(cwd, 'frontend/ts/nested/data.json'), '{}');
        await setTimeout(600);
        assert.equal(builds, 0);
        const waitForBuilds = async (count) => {
            for (let attempt = 0; attempt < 100 && builds < count; attempt++) await setTimeout(50);
            assert.equal(builds, count);
        };
        await writeFile(source, 'changed');
        await waitForBuilds(1);
        await rm(source);
        await waitForBuilds(2);
    });

test('direct invocation requires npm context and root scripts retain the intended workflow', async () => {
    assert.throws(() => startDocumentationWatcher({ npmCli: '' }), /npm run docs:watch/);
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.deepEqual(documentationPaths, [
        'typedoc.merge.json', 'docs-src/index.md', 'docs-src/typedoc.css',
        'docs-src/assets', 'frontend/ts', 'backend/ts',
    ]);
    assert.equal(manifest.scripts['docs:watch'], 'node scripts/watch-docs.mjs');
    assert.equal(manifest.scripts['docs:dev:fresh'], 'npm run docs && npm run docs:dev');
    assert.equal(manifest.scripts['docs:dev'], 'concurrently "npm:docs:watch" "npm:docs:serve"');
});
