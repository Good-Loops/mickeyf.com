import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Minimatch as EsmMinimatch } from 'minimatch';

const require = createRequire(import.meta.url);
const { Minimatch: CjsMinimatch } = require('minimatch');
const typedocRoot = dirname(require.resolve('typedoc/package.json'));
const { glob, MinimatchSet } = await import(pathToFileURL(join(typedocRoot, 'dist', 'node-utils.js')));
const normalize = value => value.replaceAll('\\', '/');

async function fixture(t) {
    const base = await realpath(tmpdir());
    const root = await mkdtemp(join(base, 'ludolume-typedoc-compat-'));
    t.after(async () => {
        assert.equal(dirname(resolve(root)), base);
        assert.ok(basename(root).startsWith('ludolume-typedoc-compat-'));
        await rm(root, { recursive: true, force: true });
    });
    for (const name of ['src/a.ts', 'src/a.test.ts', 'src/nested/b.ts', 'src/nested/c.js',
        'src/.hidden/secret.ts', 'src/other/b.ts', 'src/deep/more/z.ts', 'other/outside.ts']) {
        const path = join(root, ...name.split('/'));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `export const ${name.replace(/[^a-z0-9]/giu, '_')} = 1;\n`);
    }
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: [], skipLibCheck: true },
        include: ['src/**/*.ts'],
    }));
    return root;
}

for (const [label, Minimatch] of [['ESM', EsmMinimatch], ['CommonJS', CjsMinimatch]]) {
    test(`${label} restores TypeDoc partial-row matching across roots and Windows drives`, () => {
        const cases = [
            ['a/{b,c}/*.ts', ['a', 'b'], true],
            ['a/{b,c}/*.ts', ['a', 'd'], false],
            ['**/.hidden/*.ts', ['a', '.hidden'], true],
            ['**/../a/*.ts', ['a', '.hidden'], false], // Upstream v11 no longer explores this hidden path.
            ['C:/**/*.ts', ['c:', 'dir'], true],
            ['//?/C:/**/*.ts', ['C:', 'dir'], true],
            ['//server/share/**/*.ts', ['', '', 'server', 'share', 'dir'], true],
        ];
        for (const [pattern, segments, expected] of cases) {
            const matcher = new Minimatch(pattern, { platform: 'win32' });
            assert.equal(matcher.set.some(row => matcher.matchOne([...segments], row, true)), expected, pattern);
        }
    });

    test(`${label} retains upstream optimization expansion limits`, () => {
        const pattern = Array(30).fill('**/../a/b').join('/');
        const matcher = new Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: 64 });
        assert.ok(matcher.set.length <= 64, 'upstream fixed expansion must remain bounded');
        assert.doesNotThrow(() => matcher.set.some(row => matcher.matchOne(['a'], row, true)));
    });
}

test('TypeDoc glob discovers recursive, brace and extglob paths and honors excludes', async t => {
    const root = normalize(await fixture(t));
    const start = `${root}/src`;
    const walk = pattern => glob(`${root}/${pattern}`, start, { includeDirectories: true, followSymlinks: true }).sort();
    assert.deepEqual(walk('src/**/*.ts'), [
        `${start}/a.test.ts`, `${start}/a.ts`, `${start}/deep/more/z.ts`, `${start}/nested/b.ts`, `${start}/other/b.ts`,
    ].sort());
    assert.deepEqual(walk('src/{nested,other}/*.ts'), [`${start}/nested/b.ts`, `${start}/other/b.ts`].sort());
    assert.deepEqual(walk('src/**/!(*.test).ts'), [
        `${start}/a.ts`, `${start}/deep/more/z.ts`, `${start}/nested/b.ts`, `${start}/other/b.ts`,
    ].sort());
    assert.deepEqual(walk('src/**/.hidden/*.ts'), [`${start}/.hidden/secret.ts`]);
    assert.deepEqual(walk('src/**/../other/*.ts'), []);
    const exclude = new MinimatchSet([`${start}/**/*.test.ts`, `${start}/nested/**`]);
    assert.deepEqual(walk('src/**/*.ts').filter(path => !exclude.matchesAny(path)),
        [`${start}/a.ts`, `${start}/deep/more/z.ts`, `${start}/other/b.ts`].sort());
});

test('TypeDoc glob follows a synthetic directory symlink without escaping the fixture', async t => {
    const root = await fixture(t);
    try {
        await symlink(join(root, 'other'), join(root, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`symlinks unavailable: ${error.code}`);
        throw error;
    }
    const base = normalize(root);
    const results = glob(`${base}/src/**/*.ts`, `${base}/src`, { followSymlinks: true });
    assert.ok(results.includes(`${base}/src/linked/outside.ts`));
    assert.ok(results.every(path => path.startsWith(`${base}/src/`)));
    assert.ok(!glob(`${base}/src/**/*.ts`, `${base}/src`, { followSymlinks: false }).includes(`${base}/src/linked/outside.ts`));
});

test('unmodified TypeDoc CLI expands recursive entrypoints and honors exclusion', async t => {
    const root = await fixture(t);
    const cli = join(typedocRoot, 'bin', 'typedoc');
    const output = join(root, 'typedoc.json');
    const result = spawnSync(process.execPath, [cli, '--entryPointStrategy', 'expand',
        '--entryPoints', normalize(join(root, 'src', '**', '*.ts')),
        '--exclude', normalize(join(root, 'src', '**', '*.test.ts')),
        '--tsconfig', join(root, 'tsconfig.json'), '--json', output, '--disableSources'],
    { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, CI: 'true' } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const doc = await readFile(output, 'utf8');
    assert.match(doc, /a_ts/u);
    assert.match(doc, /b_ts/u);
    assert.doesNotMatch(doc, /a_test_ts/u);
});
