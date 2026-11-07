import path from 'node:path';
import { fileURLToPath } from 'node:url';

const failure = 'Review summary unavailable. Do not treat this as an empty report or proof of deletion.';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const descriptions = Object.freeze({
  pending: 'Check the request and its expiry; no signed approval is recorded.',
  approved: 'Approved but unused: check the request expiry and retained copies.',
  rejected: 'Check the review date; remove the returned form and all copies within the approved deadline.',
  'expired-unused': 'Request expired without use: check and remove associated form copies promptly.',
  used: 'Used for an account: retain only as required, and reconcile withdrawal or deletion.',
  'not-found': 'Investigate this missing request and its copies; absence alone does not prove deletion.',
});

function invalid() { throw new Error(failure); }
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function utcDate(value, microseconds = false) {
  if (typeof value !== 'string' || !(microseconds
    ? /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u
    : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u).test(value)) return invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== `${value.slice(0, 23)}Z`) return invalid();
  return parsed;
}

/** A summary is for the owner only; it cannot approve consent or prove a deletion. */
export function summarizeReport(report, now = Date.now()) {
  if (!exactKeys(report, ['schemaVersion', 'operation', 'observedAt', 'sourceCommit', 'target', 'schemaSha256', 'grantsSha256', 'requests'])
    || report.schemaVersion !== 1 || report.operation !== 'observe-signed-parent-form-retention'
    || !/^[a-f0-9]{40}$/u.test(report.sourceCommit) || !/^[a-f0-9]{64}$/u.test(report.schemaSha256)
    || !/^[a-f0-9]{64}$/u.test(report.grantsSha256) || !report.target || typeof report.target !== 'object'
    || Array.isArray(report.target) || !Array.isArray(report.requests) || report.requests.length < 1 || report.requests.length > 100
    || !Number.isSafeInteger(now) || now < 0) return invalid();
  const observed = utcDate(report.observedAt);
  if (observed > now || now - observed > 60 * 60 * 1000) return invalid();
  const seen = new Set();
  const lines = [];
  for (const item of report.requests) {
    if (!exactKeys(item, ['reference', 'state', 'expiresAt']) || typeof item.reference !== 'string'
      || !uuid.test(item.reference) || seen.has(item.reference) || !Object.hasOwn(descriptions, item.state)) return invalid();
    seen.add(item.reference);
    if (item.state === 'not-found' ? item.expiresAt !== null : item.expiresAt === null) return invalid();
    if (item.expiresAt !== null) utcDate(item.expiresAt, true);
    lines.push(`${item.reference} | ${item.state} | ${descriptions[item.state]}`);
  }
  return [
    `PRIVATE FORM REVIEW — observed ${report.observedAt}`,
    ...lines,
    '',
    'Check the private register for the actual deletion deadline; this report does not determine it.',
    'Check mailbox, trash, downloaded files, the encrypted archive and backups separately. A missing or failed lookup is not proof of deletion.',
    'This summary neither approves consent nor deletes data.',
  ].join('\n');
}

async function main() {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 65536) invalid();
      chunks.push(chunk);
    }
    const summary = summarizeReport(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    process.stdout.write(`${summary}\n`);
  } catch {
    process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
