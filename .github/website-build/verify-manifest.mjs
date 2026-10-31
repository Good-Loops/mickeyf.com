import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const original = read('frontend/package.json');
const website = read('.github/website-build/package.json');
assert.ok(original.devDependencies['@capacitor/cli'], 'Expected the native-only CLI in the original manifest');
delete original.devDependencies['@capacitor/cli'];
// This native-config test dependency was previously supplied transitively by the CLI.
original.devDependencies.xcode = '3.0.1';
assert.deepEqual(website, original, 'Website manifest must omit the native CLI and retain its xcode test dependency');
