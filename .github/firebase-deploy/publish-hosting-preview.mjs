import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdtemp, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import picomatch from 'picomatch';
import { fetch } from 'undici';

const API = 'https://firebasehosting.googleapis.com/v1beta1';
const PROJECT = 'noted-reef-387021';
const SHA256 = /^[0-9a-f]{64}$/u;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };
const keys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\x00-\x1f\x7f]/u.test(value);

function pattern(rule) {
  requireCondition((typeof rule.source === 'string') !== (typeof rule.regex === 'string'), 'Each Hosting rule needs one source or regex.');
  const value = rule.source ?? rule.regex;
  requireCondition(text(value), 'Invalid Hosting URL pattern.');
  return rule.source === undefined ? { regex: value } : { glob: value };
}

// The API uses a different schema from firebase.json. Reject unsupported options
// instead of silently losing routing, cache, or security behavior during upload.
export function servingConfig(hosting) {
  requireCondition(keys(hosting, ['public', 'ignore', 'rewrites', 'headers']), 'Unsupported Hosting configuration.');
  requireCondition(text(hosting.public) && !isAbsolute(hosting.public), 'Hosting public directory must be relative.');
  requireCondition(Array.isArray(hosting.ignore) && hosting.ignore.every(text), 'Invalid Hosting ignore rules.');
  requireCondition(Array.isArray(hosting.rewrites) && Array.isArray(hosting.headers), 'Hosting routing and headers are required.');
  return {
    rewrites: hosting.rewrites.map(rule => {
      requireCondition(keys(rule, ['source', 'regex', 'destination', 'run']), 'Unsupported Hosting rewrite.');
      requireCondition((rule.destination !== undefined) !== (rule.run !== undefined), 'Each rewrite needs one destination.');
      if (rule.run !== undefined) {
        requireCondition(keys(rule.run, ['serviceId', 'region']) && rule.run.serviceId === 'mickeyf-org'
          && rule.run.region === 'us-central1', 'Unexpected Hosting Cloud Run target.');
        return { ...pattern(rule), run: { ...rule.run } };
      }
      requireCondition(text(rule.destination) && rule.destination.startsWith('/'), 'Invalid Hosting file rewrite.');
      return { ...pattern(rule), path: rule.destination };
    }),
    headers: hosting.headers.map(rule => {
      requireCondition(keys(rule, ['source', 'regex', 'headers']) && Array.isArray(rule.headers), 'Unsupported Hosting header rule.');
      const headers = {};
      const seen = new Set();
      for (const item of rule.headers) {
        requireCondition(keys(item, ['key', 'value']) && typeof item.key === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(item.key)
          && text(item.value) && !seen.has(item.key.toLowerCase()), 'Invalid or duplicate Hosting header.');
        seen.add(item.key.toLowerCase());
        Object.defineProperty(headers, item.key, { value: item.value, enumerable: true });
      }
      return { ...pattern(rule), headers };
    }),
  };
}

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path !== '' && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

export async function prepareFiles(configPath, { signal } = {}) {
  const configuration = JSON.parse(await readFile(configPath, 'utf8'));
  requireCondition(keys(configuration, ['hosting']), 'Only Hosting configuration is supported.');
  const config = servingConfig(configuration.hosting);
  const base = await realpath(dirname(resolve(configPath)));
  const root = resolve(base, configuration.hosting.public);
  requireCondition(inside(base, root), 'Hosting public directory escapes the repository.');
  const rootStat = await lstat(root);
  requireCondition(rootStat.isDirectory() && !rootStat.isSymbolicLink() && await realpath(root) === root, 'Hosting public directory must not be a symlink.');
  const ignored = picomatch(configuration.hosting.ignore, { dot: true });
  const files = [];
  const names = new Set();
  let totalBytes = 0;
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      signal?.throwIfAborted();
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join('/');
      requireCondition(!/[\\%?#\x00-\x1f\x7f]/u.test(name), 'Unsafe Hosting asset path.');
      const stat = await lstat(path);
      requireCondition(!stat.isSymbolicLink() && inside(root, await realpath(path)), 'Hosting assets must not contain symlinks.');
      if (ignored(name)) continue;
      if (stat.isDirectory()) await walk(path);
      else {
        requireCondition(stat.isFile() && stat.size < 2_000_000_000 && stat.nlink === 1, 'Hosting asset is not a supported regular file.');
        totalBytes += stat.size;
        requireCondition(totalBytes <= 128 * 1024 * 1024, 'Hosting artifact exceeds the reviewed 128 MiB limit.');
        requireCondition(!names.has(name.toLowerCase()) && files.length < 20_000, 'Duplicate Hosting asset path or excessive file count.');
        names.add(name.toLowerCase());
        files.push({ path, name: `/${name}`, stat });
      }
    }
  }
  await walk(root);
  requireCondition(files.some(file => file.name === '/index.html'), 'Hosting artifact is missing index.html.');
  const temporary = await mkdtemp(join(tmpdir(), 'ludolume-hosting-upload-'));
  const cleanup = () => rm(temporary, { recursive: true, force: true });
  try {
    const byHash = new Map();
    for (const [index, file] of files.entries()) {
      signal?.throwIfAborted();
      const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const current = await handle.stat();
      if (!current.isFile() || current.ino !== file.stat.ino || current.dev !== file.stat.dev
          || current.size !== file.stat.size || current.mtimeMs !== file.stat.mtimeMs) {
        await handle.close();
        throw new Error('Hosting artifact changed while preparing upload.');
      }
      const hash = createHash('sha256');
      const compressed = join(temporary, `${index}.gz`);
      // Node's gzip stream has a zero timestamp and no filename, so the digest
      // represents the same bytes regardless of the artifact's filesystem times.
      const digest = new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } });
      await pipeline(handle.createReadStream(), createGzip({ level: 9 }), digest,
        createWriteStream(compressed, { flags: 'wx', mode: 0o600 }), { signal });
      const after = await lstat(file.path);
      requireCondition(!after.isSymbolicLink() && after.ino === current.ino && after.dev === current.dev
        && after.size === current.size && after.mtimeMs === current.mtimeMs, 'Hosting artifact changed while preparing upload.');
      file.hash = hash.digest('hex');
      byHash.set(file.hash, compressed);
    }
    return { config, files, byHash, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function responseJson(response) {
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    requireCondition(length <= 2 * 1024 * 1024, 'Hosting response exceeded the metadata size limit.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Hosting returned malformed JSON.'); }
}

export function validateUploadUrl(value, version) {
  requireCondition(value === `https://upload-firebasehosting.googleapis.com/upload/${version}/files`, 'Hosting returned an unexpected upload destination.');
  return value;
}

export async function publishPreview({ projectId, siteId, channelId, token, configPath, fetchImpl = fetch, signal }) {
  requireCondition(projectId === PROJECT && siteId === PROJECT && /^gha-[1-9][0-9]*-[1-9][0-9]*$/u.test(channelId), 'Unexpected Hosting project, site, or preview channel.');
  requireCondition(typeof token === 'string' && /^[A-Za-z0-9._~+\/-]+={0,2}$/u.test(token), 'A private access token is required.');
  const deadline = AbortSignal.any([AbortSignal.timeout(7 * 60_000), ...(signal ? [signal] : [])]);
  const prepared = await prepareFiles(configPath, { signal: deadline });
  const channel = `sites/${siteId}/channels/${channelId}`;
  async function request(url, { method = 'GET', body, raw = false, allowMissing = false } = {}) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || target.port || target.hash
        || (target.hostname !== 'firebasehosting.googleapis.com' && target.hostname !== 'upload-firebasehosting.googleapis.com')) {
      throw new Error('Unexpected Hosting request destination.');
    }
    const upload = url.startsWith('https://upload-firebasehosting.googleapis.com/');
    requireCondition(upload || url.startsWith(`${API}/sites/${siteId}/`), 'Unexpected Hosting request destination.');
    let response;
    try {
      response = await fetchImpl(target.href, {
        method, redirect: 'error', signal: AbortSignal.any([deadline, AbortSignal.timeout(raw ? 180_000 : 45_000)]),
        headers: { Authorization: `Bearer ${token}`, 'x-goog-user-project': projectId,
          ...(body === undefined ? {} : { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }) },
        ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body), ...(raw ? { duplex: 'half' } : {}) }),
      });
    } catch {
      // A timed-out mutation may already have happened. Never retry writes or
      // print transport errors that could contain request credentials.
      throw new Error(`Hosting ${method} transport failed; inspect server state before any retry.`);
    }
    if (allowMissing && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Hosting ${method} failed with HTTP ${response.status}; no automatic retry.`);
    }
    if (raw) { await response.body?.cancel(); return undefined; }
    return responseJson(response);
  }
  try {
    requireCondition(await request(`${API}/${channel}`, { allowMissing: true }) === null, 'Hosting preview channel already exists.');
    const created = await request(`${API}/sites/${siteId}/channels?channelId=${channelId}`, { method: 'POST', body: { ttl: '3600s' } });
    const expires = Date.parse(created.expireTime);
    requireCondition(created.name === channel && expires > Date.now() && expires <= Date.now() + 65 * 60_000,
      'Hosting preview creation did not return the expected expiring channel.');
    const createdVersion = await request(`${API}/sites/${siteId}/versions`, { method: 'POST', body: { config: prepared.config } });
    const version = createdVersion.name;
    const versionParts = typeof version === 'string' ? version.split('/') : [];
    requireCondition(versionParts.length === 4 && versionParts[0] === 'sites' && versionParts[1] === siteId
      && versionParts[2] === 'versions' && /^[A-Za-z0-9_-]+$/u.test(versionParts[3])
      && createdVersion.status === 'CREATED', 'Hosting returned an unexpected version.');
    const pending = new Map();
    for (let start = 0; start < prepared.files.length; start += 1000) {
      const batch = prepared.files.slice(start, start + 1000);
      const result = await request(`${API}/${version}:populateFiles`, { method: 'POST', body: { files: Object.fromEntries(batch.map(file => [file.name, file.hash])) } });
      const uploadUrl = validateUploadUrl(result.uploadUrl, version);
      const hashes = result.uploadRequiredHashes ?? [];
      const batchHashes = new Set(batch.map(file => file.hash));
      requireCondition(Array.isArray(hashes) && hashes.every(hash => typeof hash === 'string' && SHA256.test(hash) && batchHashes.has(hash)), 'Hosting requested an unknown asset hash.');
      for (const hash of hashes) pending.set(hash, uploadUrl);
    }
    const uploads = pending.entries();
    let uploadFailure;
    await Promise.all(Array.from({ length: Math.min(3, pending.size) }, async () => {
      for (const [hash, url] of uploads) {
        if (uploadFailure) return;
        const body = createReadStream(prepared.byHash.get(hash));
        try { await request(`${url}/${hash}`, { method: 'POST', body, raw: true }); }
        catch (error) { uploadFailure ??= error; }
        finally { body.destroy(); }
      }
    }));
    if (uploadFailure) throw uploadFailure;
    const finalized = await request(`${API}/${version}?updateMask=status`, { method: 'PATCH', body: { status: 'FINALIZED' } });
    requireCondition(finalized.name === version && finalized.status === 'FINALIZED', 'Hosting version was not finalized.');
    const release = await request(`${API}/${channel}/releases?versionName=${version}`, { method: 'POST', body: {} });
    const releaseParts = typeof release.name === 'string' ? release.name.split('/') : [];
    requireCondition(releaseParts.length === 6 && releaseParts[0] === 'sites' && releaseParts[1] === siteId
      && releaseParts[2] === 'channels' && releaseParts[3] === channelId && releaseParts[4] === 'releases' && /^[0-9]+$/u.test(releaseParts[5])
      && release.type === 'DEPLOY' && release.version?.name === version && release.version?.status === 'FINALIZED', 'Hosting preview release did not bind the finalized version.');
    return { channel, version, files: prepared.files.length, uploaded: pending.size };
  } finally { await prepared.cleanup(); }
}

async function main() {
  const configPath = resolve('firebase.json');
  if (process.argv.length === 3 && process.argv[2] === '--plan-only') {
    const prepared = await prepareFiles(configPath);
    try { console.log(JSON.stringify({ planOnly: true, files: prepared.files.length, distinctHashes: prepared.byHash.size, config: prepared.config })); }
    finally { await prepared.cleanup(); }
    return;
  }
  requireCondition(process.argv.length === 2, 'Use no arguments to publish the workflow preview, or --plan-only for offline validation.');
  const result = await publishPreview({ configPath, projectId: process.env.FIREBASE_PROJECT_ID, siteId: process.env.FIREBASE_SITE_ID,
    channelId: process.env.PREVIEW_CHANNEL, token: process.env.FIREBASE_ACCESS_TOKEN });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
