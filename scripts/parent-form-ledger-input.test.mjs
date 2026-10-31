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
const run = (ledger, ...options) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-LedgerPath', ledger, ...options],
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

test('deadline report sorts entered deadlines, flags missing dates, and emits nothing for invalid input',
    { skip: process.platform !== 'win32' }, async () => {
        const temp = await mkdtemp(path.join(os.tmpdir(), 'synthetic-parent-deadlines-'));
        try {
            const ledger = path.join(temp, 'register.csv');
            const fixture = await readFile(source, 'utf8');
            const [header, sample] = fixture.trimEnd().split(/\r?\n/u);
            const now = Date.now();
            const at = days => new Date(now + days * 86_400_000).toISOString();
            const row = (id, due, deleted = '') => {
                const fields = sample.split(',');
                fields[0] = `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
                fields[6] = 'PRIVATE-MESSAGE-SENTINEL';
                fields[9] = due;
                fields[10] = deleted;
                return fields.join(',');
            };
            await writeFile(ledger, `${header}\n${row(1, at(-1))}\n${row(2, at(2))}\n${row(3, at(10))}\n${row(4, '')}\n${row(5, at(-1), at(-2))}\n`);
            let result = run(ledger, '-DeadlineReport');
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /000000000001.*DUE OR OVERDUE/u);
            assert.match(result.stdout, /000000000002.*DUE WITHIN 4 DAYS/u);
            assert.match(result.stdout, /000000000003.*LATER/u);
            assert.match(result.stdout, /000000000004.*NO DEADLINE ENTERED/u);
            assert.doesNotMatch(result.stdout, /000000000005|PRIVATE-MESSAGE-SENTINEL/u);
            assert.ok(result.stdout.indexOf('000000000001') < result.stdout.indexOf('000000000002'));
            assert.ok(result.stdout.indexOf('000000000003') < result.stdout.indexOf('000000000004'));

            for (const invalid of [
                `${header}\n${row(1, at(-1))}\n${row(2, '2026-02-31T00:00:00Z')}\n`,
                `${header}\n${row(1, at(-1))}\n${row(1, at(1))}\n`,
                `${header}\n${row(1, at(-1))}\n${row(2, '', at(2))}\n`,
                `${header}\n${row(1, at(-1))}\n${row(2, 'PRIVATE-SENTINEL')}\n`,
            ]) {
                await writeFile(ledger, invalid);
                result = run(ledger, '-DeadlineReport');
                assert.notEqual(result.status, 0);
                assert.equal(result.stdout.trim(), '', 'invalid later rows must not print a partial report');
                assert.doesNotMatch(result.stderr, /PRIVATE-SENTINEL|PRIVATE-MESSAGE-SENTINEL/u);
            }
            await writeFile(ledger, `${header}\n`);
            result = run(ledger, '-DeadlineReport');
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /No outstanding rows in this register/u);
            assert.match(result.stdout, /does not prove deletion/u);
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    });

test('unmatched messages stay local and are due within 14 days of receipt',
    { skip: process.platform !== 'win32' }, async () => {
        const temp = await mkdtemp(path.join(os.tmpdir(), 'synthetic-unmatched-parent-'));
        try {
            const generated = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-NewUnmatchedReference'],
                { encoding: 'utf8', timeout: 15_000 });
            assert.equal(generated.status, 0, generated.stderr);
            const localId = generated.stdout.trim();
            assert.match(localId, /^unmatched:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
            const fixture = await readFile(source, 'utf8');
            const [header, sample] = fixture.trimEnd().split(/\r?\n/u);
            const fields = sample.split(',');
            const received = Date.now() - 12 * 86_400_000;
            fields[0] = localId;
            fields[1] = new Date(received).toISOString();
            fields[6] = 'PRIVATE-UNMATCHED-LOCATOR';
            fields[9] = '';
            fields[10] = '';
            const ledger = path.join(temp, 'register.csv');
            await writeFile(ledger, `${header}\n${sample}\n${fields.join(',')}\n`);
            let result = run(ledger, '-DeadlineReport');
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /unmatched:.*UNMATCHED MESSAGE - DUE WITHIN 4 DAYS/u);
            assert.doesNotMatch(result.stdout, /PRIVATE-UNMATCHED-LOCATOR/u);
            result = run(ledger);
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(JSON.parse(result.stdout), { references: [first] }, 'local case IDs must never reach the database report');
            await writeFile(ledger, `${header}\n${fields.join(',')}\n`);
            result = run(ledger);
            assert.notEqual(result.status, 0, 'an unmatched-only register is not a successful database lookup');
            assert.equal(result.stdout.trim(), '');
            result = run(ledger, '-DeadlineReport');
            assert.equal(result.status, 0, result.stderr);
            assert.doesNotMatch(result.stdout, /No outstanding rows/u);

            for (const change of [
                row => { row[1] = 'not-a-date'; },
                row => { row[1] = new Date(Date.now() + 86_400_000).toISOString(); },
                row => { row[6] = ''; },
                row => { row[9] = new Date(received + 15 * 86_400_000).toISOString(); },
                row => { row[10] = new Date(received - 86_400_000).toISOString(); },
            ]) {
                const bad = [...fields]; change(bad);
                await writeFile(ledger, `${header}\n${sample}\n${bad.join(',')}\n`);
                result = run(ledger, '-DeadlineReport');
                assert.notEqual(result.status, 0);
                assert.equal(result.stdout.trim(), '', 'invalid unmatched row must suppress the entire report');
                assert.doesNotMatch(result.stderr, /PRIVATE-UNMATCHED-LOCATOR/u);
            }
        } finally { await rm(temp, { recursive: true, force: true }); }
    });
