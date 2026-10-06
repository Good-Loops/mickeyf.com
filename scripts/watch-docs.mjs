import { spawn } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch } from 'chokidar';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const documentationPaths = [
    'typedoc.merge.json',
    'docs-src/index.md',
    'docs-src/typedoc.css',
    'docs-src/assets',
    'frontend/ts',
    'backend/ts',
];

export function isDocumentationPath(filePath, cwd = repositoryRoot) {
    const path = relative(cwd, resolve(cwd, filePath)).replaceAll('\\', '/');
    return documentationPaths.slice(0, 3).includes(path)
        || path === 'docs-src/assets' || path.startsWith('docs-src/assets/')
        || (path.startsWith('frontend/ts/') && /\.tsx?$/.test(path))
        || (path.startsWith('backend/ts/') && path.endsWith('.ts'));
}

export function createRebuildQueue(build, { debounceMs = 400, onError = console.error } = {}) {
    let timer;
    let activeBuild;
    let pending = false;
    let stopped = false;

    function drain() {
        if (stopped || activeBuild || !pending) return;
        pending = false;
        activeBuild = Promise.resolve().then(build).catch(onError).finally(() => {
            activeBuild = undefined;
            // A change during the build is not lost, but never starts a parallel build.
            if (pending && !timer && !stopped) drain();
        });
    }

    return {
        request() {
            if (stopped) return;
            pending = true;
            clearTimeout(timer);
            timer = setTimeout(() => {
                timer = undefined;
                drain();
            }, debounceMs);
        },
        stop() {
            stopped = true;
            pending = false;
            clearTimeout(timer);
            timer = undefined;
            // Await the current pipeline instead of killing npm without its descendants.
            return activeBuild ?? Promise.resolve();
        },
    };
}

export function runDocumentationBuild(npmCli, {
    spawnProcess = spawn,
    cwd = repositoryRoot,
} = {}) {
    return new Promise((resolveBuild, reject) => {
        // npm_execpath avoids shell quoting and Windows npm.cmd spawning differences.
        const child = spawnProcess(process.execPath, [npmCli, 'run', 'docs'], {
            cwd,
            stdio: 'inherit',
            windowsHide: true,
        });
        child.once('error', reject);
        child.once('close', (code, signal) => {
            if (code === 0) resolveBuild();
            else reject(new Error(`Documentation build failed (${signal ?? `exit ${code}`}).`));
        });
    });
}

export function startDocumentationWatcher({
    npmCli = process.env.npm_execpath,
    spawnProcess = spawn,
    watchFiles = watch,
    cwd = repositoryRoot,
    reportError = console.error,
    report = console.log,
} = {}) {
    if (!npmCli) throw new Error('Start this watcher with npm run docs:watch (or docs:dev).');

    // Chokidar 4 watches explicit paths; filtering replaces its removed glob support.
    const watcher = watchFiles(documentationPaths, {
        cwd,
        ignoreInitial: true,
        ignored: (path, stats) => !!stats?.isFile() && !isDocumentationPath(path, cwd),
    });
    let closing;
    const queue = createRebuildQueue(() => {
        report('[docs:watch] Rebuilding documentation.');
        return runDocumentationBuild(npmCli, { spawnProcess, cwd });
    }, { onError: (error) => {
        reportError(`[docs:watch] ${error.message}${closing ? '' : ' Waiting for changes.'}`);
    } });

    let finish;
    const done = new Promise((resolveDone) => { finish = resolveDone; });

    function stop(exitCode = 0) {
        if (closing) return closing;
        closing = Promise.all([queue.stop(), Promise.resolve().then(() => watcher.close())]).then(() => {
            finish(exitCode);
        }).catch((error) => {
            reportError(`[docs:watch] Cannot close file watcher: ${error.message}`);
            finish(1);
        });
        return closing;
    }

    watcher.on('all', (event, path) => {
        if (['add', 'addDir', 'change', 'unlink', 'unlinkDir'].includes(event)
            && isDocumentationPath(path, cwd)) queue.request();
    });
    watcher.once('error', (error) => {
        reportError(`[docs:watch] Cannot start file watcher: ${error.message}`);
        void stop(1);
    });

    return { stop, done };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const watcher = startDocumentationWatcher();
        const stop = () => { void watcher.stop(); };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        process.exitCode = await watcher.done;
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
    } catch (error) {
        console.error(`[docs:watch] ${error.message}`);
        process.exitCode = 1;
    }
}
