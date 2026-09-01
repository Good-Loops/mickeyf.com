import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    containsNulByte,
    isEligibleAssetPath,
    normalizeTrailingWhitespace,
    parseNulDelimitedList,
} from './normalize-unity-yaml-whitespace.mjs';

const scriptPath = fileURLToPath(new URL('./normalize-unity-yaml-whitespace.mjs', import.meta.url));

describe('normalizeTrailingWhitespace', () => {
    test('preserves LF line endings while removing trailing whitespace', () => {
        const input = 'foo \nbar\n';
        assert.equal(normalizeTrailingWhitespace(input), 'foo\nbar\n');
    });

    test('preserves CRLF line endings while removing trailing whitespace', () => {
        const input = 'foo \r\nbar\t\r\n';
        assert.equal(normalizeTrailingWhitespace(input), 'foo\r\nbar\r\n');
    });

    test('removes trailing whitespace at end of file with no trailing newline', () => {
        const input = 'foo\t  ';
        assert.equal(normalizeTrailingWhitespace(input), 'foo');
    });

    test('preserves internal, non-trailing whitespace', () => {
        const input = 'a  b \tc\n';
        assert.equal(normalizeTrailingWhitespace(input), 'a  b \tc\n');
    });

    test('leaves lines with no trailing whitespace unchanged', () => {
        const input = 'clean line\nanother clean line\n';
        assert.equal(normalizeTrailingWhitespace(input), input);
    });

    test('handles blank lines with trailing whitespace', () => {
        const input = 'a\n   \nb\n';
        assert.equal(normalizeTrailingWhitespace(input), 'a\n\nb\n');
    });
});

describe('isEligibleAssetPath', () => {
    for (const extension of ['.unity', '.prefab', '.asset', '.meta', '.mat', '.anim', '.controller']) {
        test(`treats ${extension} files as eligible`, () => {
            assert.equal(isEligibleAssetPath(`Assets/Thing${extension}`), true);
        });

        test(`treats uppercase ${extension.toUpperCase()} files as eligible`, () => {
            assert.equal(isEligibleAssetPath(`Assets/Thing${extension.toUpperCase()}`), true);
        });
    }

    for (const extension of ['.cs', '.png', '.fbx', '.json', '']) {
        test(`treats ${extension || '(no extension)'} files as ineligible`, () => {
            assert.equal(isEligibleAssetPath(`Assets/Thing${extension}`), false);
        });
    }

    test('preserves Unity canonical whitespace in ProjectSettings.asset', () => {
        assert.equal(
            isEligibleAssetPath('unity/three-bosses/ProjectSettings/ProjectSettings.asset'),
            false,
        );
        assert.equal(
            isEligibleAssetPath('unity\\three-bosses\\ProjectSettings\\ProjectSettings.asset'),
            false,
        );
    });
});

describe('containsNulByte', () => {
    test('detects a NUL byte', () => {
        assert.equal(containsNulByte(Buffer.from([0x61, 0x00, 0x62])), true);
    });

    test('returns false for plain text', () => {
        assert.equal(containsNulByte(Buffer.from('hello world', 'utf8')), false);
    });
});

describe('parseNulDelimitedList', () => {
    test('splits on NUL and drops empty trailing entries', () => {
        assert.deepEqual(parseNulDelimitedList('a/b.unity\0c/d.meta\0'), ['a/b.unity', 'c/d.meta']);
    });

    test('returns an empty array for empty input', () => {
        assert.deepEqual(parseNulDelimitedList(''), []);
    });
});

function createTempGitRepo() {
    const repoRoot = mkdtempSync(join(tmpdir(), 'unity-yaml-normalizer-'));
    execFileSync('git', ['init', '--quiet'], { cwd: repoRoot });
    return repoRoot;
}

function runScript(repoRoot) {
    return spawnSync(process.execPath, [scriptPath, '--staged'], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
}

describe('integration: --staged normalization', () => {
    let repoRoot;
    let unityFilePath;

    before(() => {
        repoRoot = createTempGitRepo();
        mkdirSync(join(repoRoot, 'unity', 'three-bosses', 'Assets', 'Scenes'), { recursive: true });
        unityFilePath = join(repoRoot, 'unity', 'three-bosses', 'Assets', 'Scenes', 'Level1.unity');
        writeFileSync(unityFilePath, '%YAML 1.1\n--- !u!1 &1\nGameObject:  \n  name: Test  \n');
        execFileSync('git', ['add', '--', 'unity/three-bosses/Assets/Scenes/Level1.unity'], { cwd: repoRoot });
    });

    after(() => {
        rmSync(repoRoot, { recursive: true, force: true });
    });

    test('first run normalizes trailing whitespace, restages, and stops for inspection', () => {
        const result = runScript(repoRoot);

        assert.notEqual(result.status, 0);
        assert.match(result.stdout, /Level1\.unity/);

        const content = readFileSync(unityFilePath, 'utf8');
        assert.equal(content, '%YAML 1.1\n--- !u!1 &1\nGameObject:\n  name: Test\n');

        const staged = execFileSync(
            'git',
            ['diff', '--cached', '--name-only', '--', 'unity/three-bosses'],
            { cwd: repoRoot, encoding: 'utf8' },
        );
        assert.match(staged, /Level1\.unity/);

        const unstaged = execFileSync(
            'git',
            ['diff', '--name-only', '--', 'unity/three-bosses'],
            { cwd: repoRoot, encoding: 'utf8' },
        );
        assert.equal(unstaged.trim(), '');
    });

    test('second run succeeds because no further normalization is required', () => {
        const result = runScript(repoRoot);
        assert.equal(result.status, 0);
    });

    test('git diff --cached --check succeeds after normalization', () => {
        const result = spawnSync('git', ['diff', '--cached', '--check'], {
            cwd: repoRoot,
            encoding: 'utf8',
        });
        assert.equal(result.status, 0);
    });
});

describe('integration: partially staged Unity file is rejected', () => {
    let repoRoot;
    let unityFilePath;
    let stagedContent;
    let workingTreeContentBeforeRun;

    before(() => {
        repoRoot = createTempGitRepo();
        mkdirSync(join(repoRoot, 'unity', 'three-bosses', 'Assets', 'Scenes'), { recursive: true });
        unityFilePath = join(repoRoot, 'unity', 'three-bosses', 'Assets', 'Scenes', 'Level2.unity');

        writeFileSync(unityFilePath, '%YAML 1.1\nGameObject:  \n  name: Original  \n');
        execFileSync('git', ['add', '--', 'unity/three-bosses/Assets/Scenes/Level2.unity'], { cwd: repoRoot });

        // Further, unstaged edits after staging create a partially staged file.
        writeFileSync(unityFilePath, '%YAML 1.1\nGameObject:  \n  name: Original  \n  extra: field \n');

        stagedContent = execFileSync(
            'git',
            ['show', ':unity/three-bosses/Assets/Scenes/Level2.unity'],
            { cwd: repoRoot, encoding: 'utf8' },
        );
        workingTreeContentBeforeRun = readFileSync(unityFilePath, 'utf8');
    });

    after(() => {
        rmSync(repoRoot, { recursive: true, force: true });
    });

    test('aborts without modifying or restaging anything', () => {
        const result = runScript(repoRoot);

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Level2\.unity/);

        const stagedAfter = execFileSync(
            'git',
            ['show', ':unity/three-bosses/Assets/Scenes/Level2.unity'],
            { cwd: repoRoot, encoding: 'utf8' },
        );
        assert.equal(stagedAfter, stagedContent);

        const workingTreeAfter = readFileSync(unityFilePath, 'utf8');
        assert.equal(workingTreeAfter, workingTreeContentBeforeRun);
    });
});
