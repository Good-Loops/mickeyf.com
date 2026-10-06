import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADVISORY, EXPIRES_AT, evaluateHostingAudit, verifyHostingPins } from './audit-hosting.mjs';

function report() {
  const finding = (name, via) => ({ name, severity: 'high', isDirect: name === 'firebase-tools',
    nodes: [`node_modules/${name}`], via });
  return { auditReportVersion: 2, vulnerabilities: {
    braces: finding('braces', [{ name: 'braces', dependency: 'braces', url: ADVISORY, severity: 'high', range: '<=3.0.3' }]),
    chokidar: finding('chokidar', ['braces']), 'firebase-tools': finding('firebase-tools', ['chokidar']),
  }, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 3, critical: 0, total: 3 } } };
}
const beforeExpiry = EXPIRES_AT - 1;
test('accepts only the approved high dependency chain through the last instant of October 13', () => {
  assert.equal(evaluateHostingAudit(report(), beforeExpiry).exceptionUsed, true);
  assert.throws(() => evaluateHostingAudit(report(), EXPIRES_AT), /expired/u);
});
test('rejects new, changed, nested or critical advisories', () => {
  for (const mutate of [
    value => value.vulnerabilities.braces.via.push({ url: 'https://github.com/advisories/another' }),
    value => { value.vulnerabilities.chokidar.via = ['braces', 'other']; },
    value => { value.vulnerabilities.braces.via[0].url += '-changed'; },
    value => { value.vulnerabilities.braces.nodes.push('node_modules/other/node_modules/braces'); },
    value => { value.vulnerabilities.braces.severity = 'critical'; value.metadata.vulnerabilities.high--; value.metadata.vulnerabilities.critical++; },
    value => { value.vulnerabilities.other = { name: 'other', severity: 'high', via: ['braces'] }; value.metadata.vulnerabilities.high++; value.metadata.vulnerabilities.total++; },
  ]) { const value = report(); mutate(value); assert.throws(() => evaluateHostingAudit(value, beforeExpiry)); }
});
test('fails closed on unavailable, malformed or incomplete audit responses', () => {
  for (const value of [null, {}, { error: { code: 'NETWORK_ERROR' } }, { ...report(), auditReportVersion: 1 },
    { ...report(), metadata: {} }, { ...report(), vulnerabilities: {} }]) {
    assert.throws(() => evaluateHostingAudit(value, beforeExpiry));
  }
  assert.throws(() => evaluateHostingAudit(report(), Number.NaN));
});
test('a clean report passes after expiry without an exception', () => {
  const value = report(); value.vulnerabilities = {};
  value.metadata.vulnerabilities.high = 0; value.metadata.vulnerabilities.total = 0;
  assert.deepEqual(evaluateHostingAudit(value, EXPIRES_AT), { exceptionUsed: false });
});
test('pins both locked and installed Hosting packages', () => {
  const versions = { 'firebase-tools': '15.32.0', chokidar: '3.6.0', braces: '3.0.3' };
  const manifest = { dependencies: { 'firebase-tools': '15.32.0' } };
  const lock = { lockfileVersion: 3, packages: Object.fromEntries(Object.entries(versions)
    .map(([name, version]) => [`node_modules/${name}`, { version, integrity: 'sha512-YWJjZA==' }])) };
  const installed = Object.fromEntries(Object.entries(versions).map(([name, version]) => [name, { name, version }]));
  verifyHostingPins(manifest, lock, installed);
  installed.braces.version = '3.0.4';
  assert.throws(() => verifyHostingPins(manifest, lock, installed), /pin mismatch/u);
  installed.braces.version = '3.0.3'; lock.packages['node_modules/braces'].integrity = '';
  assert.throws(() => verifyHostingPins(manifest, lock, installed), /pin mismatch/u);
});
