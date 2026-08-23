import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const UNITY_PROJECT_PATHSPEC = 'unity/three-bosses';

const ELIGIBLE_EXTENSIONS = new Set([
    '.unity',
    '.prefab',
    '.asset',
    '.meta',
    '.mat',
    '.anim',
    '.controller',
]);

/**
 * Splits a NUL-delimited Git command output into a list of paths.
 * @param {string} output
 * @returns {string[]}
 */
export function parseNulDelimitedList(output) {
    return output.split('\0').filter((entry) => entry.length > 0);
}

/**
 * Returns whether a path's extension makes it an eligible Unity text asset.
 * Comparison is case-insensitive.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isEligibleAssetPath(filePath) {
    return ELIGIBLE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * Returns whether a buffer contains a NUL byte, used as a cheap binary check.
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function containsNulByte(buffer) {
    return buffer.includes(0);
}

/**
 * Removes spaces and tabs that appear immediately before an LF, a CRLF, or
 * the end of the text. All other bytes, including existing line-ending
 * style, are preserved untouched.
 * @param {string} text
 * @returns {string}
 */
export function normalizeTrailingWhitespace(text) {
    return text
        .replace(/[ \t]+(\r\n|\n)/g, '$1')
        .replace(/[ \t]+$/, '');
}

/**
 * Decodes a buffer to a string that preserves every byte 1:1, so that
 * re-encoding with the same codec reproduces the original bytes exactly.
 * @param {Buffer} buffer
 * @returns {string}
 */
function bufferToBytePreservingString(buffer) {
    return buffer.toString('latin1');
}

/**
 * Encodes a byte-preserving string (see {@link bufferToBytePreservingString})
 * back into a buffer.
 * @param {string} text
 * @returns {Buffer}
 */
function bytePreservingStringToBuffer(text) {
    return Buffer.from(text, 'latin1');
}

function runGit(repoRoot, args) {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function getRepositoryRoot() {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function getStagedEligiblePaths(repoRoot) {
    const output = runGit(repoRoot, [
        'diff',
        '--cached',
        '--name-only',
        '-z',
        '--diff-filter=ACMR',
        '--',
        UNITY_PROJECT_PATHSPEC,
    ]);

    return parseNulDelimitedList(output).filter(isEligibleAssetPath);
}

function getUnstagedChangedPaths(repoRoot) {
    const output = runGit(repoRoot, [
        'diff',
        '--name-only',
        '-z',
        '--',
        UNITY_PROJECT_PATHSPEC,
    ]);

    return new Set(parseNulDelimitedList(output));
}

function writeFileAtomic(targetPath, buffer) {
    const dir = dirname(targetPath);
    const tempPath = join(
        dir,
        `.${basename(targetPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    writeFileSync(tempPath, buffer);
    renameSync(tempPath, targetPath);
}

function runCachedWhitespaceCheck(repoRoot) {
    const result = spawnSync('git', ['diff', '--cached', '--check'], {
        cwd: repoRoot,
        stdio: 'inherit',
    });

    return result.status === 0;
}

function main() {
    if (!process.argv.includes('--staged')) {
        console.error('Usage: node scripts/normalize-unity-yaml-whitespace.mjs --staged');
        process.exitCode = 1;
        return;
    }

    const repoRoot = getRepositoryRoot();
    const stagedEligiblePaths = getStagedEligiblePaths(repoRoot);

    if (stagedEligiblePaths.length === 0) {
        if (!runCachedWhitespaceCheck(repoRoot)) {
            process.exitCode = 1;
            return;
        }

        process.exitCode = 0;
        return;
    }

    const unstagedChangedPaths = getUnstagedChangedPaths(repoRoot);
    const partiallyStagedPaths = stagedEligiblePaths.filter((path) => unstagedChangedPaths.has(path));

    if (partiallyStagedPaths.length > 0) {
        console.error('Refusing to normalize partially staged Unity files. Stage or discard the');
        console.error('remaining working-tree changes for these paths, then retry the commit:');
        for (const path of partiallyStagedPaths) {
            console.error(`  ${path}`);
        }

        process.exitCode = 1;
        return;
    }

    const changedPaths = [];

    for (const path of stagedEligiblePaths) {
        const absolutePath = join(repoRoot, path);
        let original;

        try {
            original = readFileSync(absolutePath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                continue;
            }

            throw error;
        }

        if (containsNulByte(original)) {
            continue;
        }

        const originalText = bufferToBytePreservingString(original);
        const normalizedText = normalizeTrailingWhitespace(originalText);

        if (normalizedText === originalText) {
            continue;
        }

        writeFileAtomic(absolutePath, bytePreservingStringToBuffer(normalizedText));
        changedPaths.push(path);
    }

    if (changedPaths.length === 0) {
        if (!runCachedWhitespaceCheck(repoRoot)) {
            process.exitCode = 1;
            return;
        }

        process.exitCode = 0;
        return;
    }

    runGit(repoRoot, ['add', '--', ...changedPaths]);

    const restagedUnstagedPaths = new Set(
        parseNulDelimitedList(
            runGit(repoRoot, ['diff', '--name-only', '-z', '--', ...changedPaths]),
        ),
    );

    if (restagedUnstagedPaths.size > 0) {
        console.error('The following files changed on disk again after normalization, likely');
        console.error('because Unity or another program rewrote them while the hook was running:');
        for (const path of restagedUnstagedPaths) {
            console.error(`  ${path}`);
        }

        process.exitCode = 1;
        return;
    }

    if (!runCachedWhitespaceCheck(repoRoot)) {
        process.exitCode = 1;
        return;
    }

    console.log('Normalized trailing whitespace in Unity-generated files:');
    for (const path of changedPaths) {
        console.log(`  ${path}`);
    }

    console.log('');
    console.log('The commit was intentionally stopped so the normalized changes can be');
    console.log('inspected. Review the diff, re-stage if needed, and run the commit again.');

    process.exitCode = 1;
}

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
    main();
}
