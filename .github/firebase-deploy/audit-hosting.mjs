import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADVISORY = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';
// Owner approved through October 13, inclusive, in America/Sao_Paulo.
export const EXPIRES_AT = Date.parse('2026-10-14T03:00:00Z');
const directory = dirname(fileURLToPath(import.meta.url));
const pins = Object.freeze({ 'firebase-tools': '15.32.0', chokidar: '3.6.0', braces: '3.0.3' });
const severities = ['info', 'low', 'moderate', 'high', 'critical'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);

export function verifyHostingPins(manifest, lock, installed) {
  if (manifest?.dependencies?.['firebase-tools'] !== pins['firebase-tools'] || lock?.lockfileVersion !== 3) {
    throw new Error('Hosting exception requires the reviewed locked Firebase CLI.');
  }
  for (const [name, version] of Object.entries(pins)) {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (entry?.version !== version || !/^sha512-[A-Za-z0-9+/]+=*$/u.test(entry.integrity ?? '')
        || installed[name]?.name !== name || installed[name]?.version !== version) {
      throw new Error(`Hosting exception pin mismatch: ${name}.`);
    }
  }
}

export function evaluateHostingAudit(report, now = Date.now()) {
  if (!Number.isFinite(now) || report?.auditReportVersion !== 2 || report.error
      || !record(report.vulnerabilities) || !record(report.metadata?.vulnerabilities)) {
    throw new Error('Dependency audit report is unavailable or malformed.');
  }
  const counts = Object.fromEntries(severities.map(severity => [severity, 0]));
  for (const [name, finding] of Object.entries(report.vulnerabilities)) {
    if (!record(finding) || finding.name !== name || !severities.includes(finding.severity)
        || !Array.isArray(finding.via) || !finding.via.length) throw new Error('Malformed dependency finding.');
    counts[finding.severity]++;
  }
  if (severities.some(severity => report.metadata.vulnerabilities[severity] !== counts[severity])
      || report.metadata.vulnerabilities.total !== Object.values(counts).reduce((sum, count) => sum + count, 0)) {
    throw new Error('Dependency audit counts do not match its findings.');
  }
  const blocked = Object.entries(report.vulnerabilities).filter(([, finding]) => ['high', 'critical'].includes(finding.severity));
  if (!blocked.length) return { exceptionUsed: false };
  if (now >= EXPIRES_AT) throw new Error('The approved Hosting braces exception has expired.');
  if (!same(blocked.map(([name]) => name).sort(), Object.keys(pins).sort())) {
    throw new Error('An unapproved high or critical dependency finding blocks Hosting.');
  }
  for (const [name, finding] of blocked) {
    const expectedVia = name === 'firebase-tools' ? ['chokidar'] : name === 'chokidar' ? ['braces'] : null;
    if (finding.severity !== 'high' || !same(finding.nodes, [`node_modules/${name}`])
        || finding.isDirect !== (name === 'firebase-tools')
        || (expectedVia && !same(finding.via, expectedVia))) {
      throw new Error('Hosting finding differs from the approved dependency chain.');
    }
  }
  const [advisory, ...additional] = report.vulnerabilities.braces.via;
  if (additional.length || !record(advisory) || advisory.url !== ADVISORY || advisory.severity !== 'high'
      || advisory.name !== 'braces' || advisory.dependency !== 'braces' || advisory.range !== '<=3.0.3') {
    throw new Error('Hosting braces advisory differs from the owner-approved exception.');
  }
  return { exceptionUsed: true, advisory: ADVISORY, expiresAt: new Date(EXPIRES_AT).toISOString() };
}

export function runHostingAudit() {
  const readJson = path => JSON.parse(readFileSync(resolve(directory, path), 'utf8'));
  verifyHostingPins(readJson('package.json'), readJson('package-lock.json'), Object.fromEntries(
    Object.keys(pins).map(name => [name, readJson(`node_modules/${name}/package.json`)])));
  // npm run supplies npm_execpath on Windows and Unix without shell interpolation.
  if (!process.env.npm_execpath) throw new Error('Run this gate with npm run audit:hosting.');
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'audit', '--omit=dev', '--json'], {
    cwd: directory, encoding: 'utf8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error || result.signal || ![0, 1].includes(result.status)) throw new Error('npm audit did not complete successfully.');
  const decision = evaluateHostingAudit(JSON.parse(result.stdout));
  console.log(JSON.stringify({ scope: '.github/firebase-deploy', ...decision }));
  return decision;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { runHostingAudit(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
