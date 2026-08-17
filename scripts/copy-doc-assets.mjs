import { cp } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(repositoryRoot, 'docs-src', 'assets');
const target = resolve(repositoryRoot, 'docs', 'assets');

for (const path of [source, target]) {
    const relativePath = relative(repositoryRoot, path);

    if (
        !relativePath ||
        isAbsolute(relativePath) ||
        relativePath === '..' ||
        relativePath.startsWith(`..${sep}`)
    ) {
        throw new Error(`Refusing to access a path outside the repository: ${path}`);
    }
}

await cp(source, target, {
    recursive: true,
    force: true,
});
