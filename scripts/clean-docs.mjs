import { rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generatedPaths = ['.typedoc-tmp', 'docs'];

for (const generatedPath of generatedPaths) {
    const target = resolve(repositoryRoot, generatedPath);
    const relativeTarget = relative(repositoryRoot, target);

    if (
        !relativeTarget ||
        isAbsolute(relativeTarget) ||
        relativeTarget === '..' ||
        relativeTarget.startsWith(`..${sep}`)
    ) {
        throw new Error(`Refusing to remove a path outside the repository: ${target}`);
    }

    await rm(target, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
    });
}
