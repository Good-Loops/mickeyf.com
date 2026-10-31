import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { summarizeReport } from './parent-form-retention-summary.mjs';

const script = fileURLToPath(new URL('./parent-form-retention-summary.mjs', import.meta.url));
const backend = fileURLToPath(new URL('../backend/', import.meta.url));
const now = Date.parse('2026-10-31T12:00:00.000Z');
const ref = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const item = (number, state) => ({ reference: ref(number), state,
  expiresAt: state === 'not-found' ? null : '2026-11-01T12:00:00.000000Z' });
const report = requests => ({ schemaVersion: 1, operation: 'observe-signed-parent-form-retention',
  observedAt: '2026-10-31T11:59:59.000Z', sourceCommit: 'a'.repeat(40), target: { privateTarget: 'DO-NOT-ECHO' },
  schemaSha256: 'b'.repeat(64), grantsSha256: 'c'.repeat(64), requests });

test('all states receive conservative owner guidance without printing private target details', () => {
  const states = ['pending', 'approved', 'rejected', 'expired-unused', 'used', 'not-found'];
  const output = summarizeReport(report(states.map((state, index) => item(index + 1, state))), now);
  for (const state of states) assert.match(output, new RegExp(`\\| ${state} \\|`, 'u'));
  assert.match(output, /absence alone does not prove deletion/u);
  assert.match(output, /actual deletion deadline/u);
  assert.match(output, /backups separately/u);
  assert.doesNotMatch(output, /DO-NOT-ECHO|a{40}|b{64}/u);
});

test('stale, future, malformed, duplicate and inconsistent reports fail closed', () => {
  const good = report([item(1, 'pending')]);
  const cases = [
    { ...good, observedAt: '2026-10-31T10:59:59.000Z' },
    { ...good, observedAt: '2026-10-31T12:00:00.001Z' },
    { ...good, observedAt: '2026-02-30T11:59:59.000Z' },
    { ...good, requests: [] },
    { ...good, requests: [item(1, 'pending'), item(1, 'used')] },
    { ...good, requests: [item(1, 'unknown')] },
    { ...good, requests: [{ ...item(1, 'not-found'), expiresAt: '2026-11-01T12:00:00.000000Z' }] },
    { ...good, requests: [{ ...item(1, 'pending'), expiresAt: null }] },
    { ...good, requests: [{ ...item(1, 'pending'), note: 'unexpected' }] },
    { ...good, requests: Array.from({ length: 101 }, (_, index) => item(index + 1, 'pending')) },
    { ...good, operation: 'unexpected' },
  ];
  for (const candidate of cases) assert.throws(() => summarizeReport(candidate, now), /summary unavailable/iu);
});

test('CLI rejects incomplete input without emitting a partial summary', () => {
  for (const input of ['', '{', '{}', 'x'.repeat(65537)]) {
    const result = spawnSync(process.execPath, [script], { input, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Do not treat this as an empty report or proof of deletion/u);
  }
});

test('CLI reads a complete fresh report and prints only the private action summary', () => {
  const input = { ...report([item(1, 'not-found')]), observedAt: new Date().toISOString() };
  const result = spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not-found.*absence alone does not prove deletion/u);
  assert.doesNotMatch(result.stdout, /DO-NOT-ECHO/u);
});

test('the guarded report output is accepted by the summary CLI', () => {
  const producer = `
    const { fixture, settings } = require('./ts/migrations/childSignedFormMetadata.testFixture');
    const { CHILD_SIGNED_FORM_SQL_SHA256 } = require('./ts/migrations/childSignedFormOperation');
    const { observeSignedParentFormRetention } = require('./ts/accounts/signedParentFormRetention');
    const f = fixture(true);
    const connection = { async query(sql, values) {
      if (sql.includes('FROM parent_signed_forms WHERE reference IN')) return [[{
        reference: '00000000-0000-4000-8000-000000000001', status: 'approved',
        expiresAt: '2030-01-01T00:00:00.000001Z', expired: 0
      }], []];
      return f.connection.query(sql, values);
    } };
    observeSignedParentFormRetention({ connection, settings, source: { sourceCommit: 'a'.repeat(40),
      sqlSha256: CHILD_SIGNED_FORM_SQL_SHA256 } }, ['00000000-0000-4000-8000-000000000001'])
      .then(value => process.stdout.write(JSON.stringify(value)))
      .catch(() => { process.exitCode = 1; });`;
  const generated = spawnSync(process.execPath, ['-r', 'ts-node/register', '-e', producer],
    { cwd: backend, encoding: 'utf8', timeout: 30000 });
  assert.equal(generated.status, 0, generated.stderr);
  const result = spawnSync(process.execPath, [script], { input: generated.stdout, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /00000000-0000-4000-8000-000000000001 \| approved \|/u);
});
