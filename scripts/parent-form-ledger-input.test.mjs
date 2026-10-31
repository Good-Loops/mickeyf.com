import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts/parent-form-ledger-input.ps1');
const source = path.join(root, 'release-prep/2026-10-21/parent-form-retention-register.example.csv');
const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
const run = ledger => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, '-LedgerPath', ledger],
    { encoding: 'utf8', timeout: 15_000 });

test('private ledger conversion emits only unique outstanding references and fails closed',
    { skip: process.platform !== 'win32' }, async () => {
        const temp = await mkdtemp(path.join(os.tmpdir(), 'synthetic-parent-register-'));
        try {
            const ledger = path.join(temp, 'register.csv');
            const fixture = await readFile(source, 'utf8');
            const row = fixture.trimEnd().split(/\r?\n/u)[1];
            await writeFile(ledger, `${fixture.trimEnd()}\n${row.replace(first, second)}2026-10-30T12:00:00Z\n`);
            let result = run(ledger);
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(JSON.parse(result.stdout), { references: [first] });
            assert.doesNotMatch(result.stdout, /SYNTHETIC-MESSAGE|SYNTHETIC-FILE|11111111/u);
            await writeFile(ledger, fixture.replace('SYNTHETIC-MESSAGE-ONLY', '"SYNTHETIC,MESSAGE"'));
            result = run(ledger);
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(JSON.parse(result.stdout), { references: [first] });

            for (const invalid of [
                `${fixture.trimEnd()}\n${row}\n`, // duplicate reference
                fixture.replace('request_reference', 'reference'),
                fixture.replace(first, 'not-a-reference'),
                `${fixture.trimEnd()}\n${row.replace(first, second)}not-a-date\n`,
                `${fixture.trimEnd()}\n${row.replace(first, second)}9999-10-30T12:00:00Z\n`,
                fixture.replace('SYNTHETIC-MESSAGE-ONLY', 'UNQUOTED,EXTRA-COLUMN'),
                fixture.replace('SYNTHETIC-MESSAGE-ONLY', '"UNCLOSED-QUOTE'),
                fixture.replace('SYNTHETIC-MESSAGE-ONLY', 'PRIVATE-SENTINEL').replace(first, 'bad'),
            ]) {
                await writeFile(ledger, invalid);
                result = run(ledger);
                assert.notEqual(result.status, 0);
                assert.equal(result.stdout.trim(), '');
                assert.doesNotMatch(result.stderr, /PRIVATE-SENTINEL|SYNTHETIC-MESSAGE|register\.csv/u);
            }

            await writeFile(ledger, `${fixture.trimEnd()}2026-10-30T12:00:00Z\n`);
            result = run(ledger);
            assert.notEqual(result.status, 0, 'an empty active set must not look like a successful SQL report');
            assert.equal(result.stdout.trim(), '');

            const header = fixture.split(/\r?\n/u)[0];
            const oversized = Array.from({ length: 101 }, (_, index) => row.replace(first,
                `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`));
            await writeFile(ledger, `${header}\n${oversized.join('\n')}\n`);
            result = run(ledger);
            assert.notEqual(result.status, 0, 'more than 100 active rows must not produce a truncated list');
            assert.equal(result.stdout.trim(), '');
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    });
