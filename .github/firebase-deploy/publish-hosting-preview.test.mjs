import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { prepareFiles, publishPreview, servingConfig, validateUploadUrl } from './publish-hosting-preview.mjs';

const site = 'noted-reef-387021';
const channelId = 'gha-12-1';
const channel = `sites/${site}/channels/${channelId}`;
const version = `sites/${site}/versions/preview123`;
const api = 'https://firebasehosting.googleapis.com/v1beta1';
const uploadUrl = `https://upload-firebasehosting.googleapis.com/upload/${version}/files`;
const config = { hosting: { public: 'dist', ignore: ['**/.*', '**/node_modules/**'],
  rewrites: [{ source: '/auth/**', run: { serviceId: 'mickeyf-org', region: 'us-central1' } }, { source: '**', destination: '/index.html' }],
  headers: [{ regex: '.*', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }] }] } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function fixture(t, files = { 'index.html': '<html>release</html>', 'assets/game.wasm': 'wasm payload', '.private': 'ignored' }, configuration = config) {
  const root = await mkdtemp(join(tmpdir(), 'hosting-publisher-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'firebase.json');
  await writeFile(configPath, JSON.stringify(configuration));
  await mkdir(join(root, 'dist'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, 'dist', name)), { recursive: true });
    await writeFile(join(root, 'dist', name), content);
  }
  return { root, configPath };
}

function protocol({ mutate = (body) => body, fail, delayUpload = false } = {}) {
  const requests = [];
  const uploaded = new Map();
  const batches = [];
  let active = 0;
  let maximum = 0;
  return {
    requests, uploaded, batches,
    get maximum() { return maximum; },
    async fetchImpl(url, options) {
      requests.push({ url, method: options.method });
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      assert.equal(options.headers['x-goog-user-project'], site);
      if (fail?.(url, options)) throw new Error('transport failure with a private token that must not escape');
      if (url === `${api}/${channel}`) return json({}, 404);
      if (url === `${api}/sites/${site}/channels?channelId=${channelId}`) {
        assert.deepEqual(JSON.parse(options.body), { ttl: '3600s' });
        return json(mutate({ name: channel, expireTime: new Date(Date.now() + 3600_000).toISOString() }, 'channel'));
      }
      if (url === `${api}/sites/${site}/versions`) {
        assert.deepEqual(JSON.parse(options.body), { config: servingConfig(config.hosting) });
        return json(mutate({ name: version, status: 'CREATED' }, 'version'));
      }
      if (url === `${api}/${version}:populateFiles`) {
        const files = JSON.parse(options.body).files;
        batches.push(files);
        assert.ok(Object.keys(files).length <= 1000);
        return json(mutate({ uploadUrl, uploadRequiredHashes: [...new Set(Object.values(files))] }, 'populate'));
      }
      if (url.startsWith(`${uploadUrl}/`)) {
        active++;
        maximum = Math.max(maximum, active);
        try {
          const chunks = [];
          for await (const chunk of options.body) chunks.push(chunk);
          const bytes = Buffer.concat(chunks);
          const hash = url.slice(uploadUrl.length + 1);
          assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
          uploaded.set(hash, gunzipSync(bytes).toString());
          if (delayUpload) await new Promise(resolve => setTimeout(resolve, 5));
          return new Response(null, { status: 200 });
        } finally { active--; }
      }
      if (url === `${api}/${version}?updateMask=status`) {
        assert.deepEqual(JSON.parse(options.body), { status: 'FINALIZED' });
        return json(mutate({ name: version, status: 'FINALIZED' }, 'finalize'));
      }
      if (url === `${api}/${channel}/releases?versionName=${version}`) {
        return json(mutate({ name: `${channel}/releases/123`, type: 'DEPLOY', version: { name: version, status: 'FINALIZED' } }, 'release'));
      }
      assert.fail(`Unexpected request: ${url}`);
    },
  };
}

const publish = (configPath, transport, overrides = {}) => publishPreview({ configPath, projectId: site, siteId: site,
  channelId, token: 'test-token', fetchImpl: transport.fetchImpl, ...overrides });

test('converts every current production rule without changing header or rewrite order', async () => {
  const current = JSON.parse(await readFile(new URL('../../firebase.json', import.meta.url), 'utf8'));
  const converted = servingConfig(current.hosting);
  assert.equal(converted.headers.length, current.hosting.headers.length);
  assert.deepEqual(converted.rewrites, current.hosting.rewrites.map(({ source, destination, run }) => ({ glob: source, ...(run ? { run } : { path: destination }) })));
  converted.headers.forEach((rule, index) => {
    const original = current.hosting.headers[index];
    assert.deepEqual(rule, { ...(original.regex ? { regex: original.regex } : { glob: original.source }), headers: Object.fromEntries(original.headers.map(({ key, value }) => [key, value])) });
  });
});

test('unsupported configuration, ambiguous rules, foreign rewrites, and header injection fail closed', () => {
  for (const changed of [
    { ...config.hosting, cleanUrls: true },
    { ...config.hosting, rewrites: [{ source: '**', regex: '.*', destination: '/index.html' }] },
    { ...config.hosting, rewrites: [{ source: '/auth/**', run: { serviceId: 'foreign', region: 'us-central1' } }] },
    { ...config.hosting, headers: [{ source: '**', headers: [{ key: 'X-Test', value: 'ok\r\ninjected: value' }] }] },
    { ...config.hosting, headers: [{ source: '**', headers: [{ key: 'X-Test', value: 'a' }, { key: 'x-test', value: 'b' }] }] },
  ]) assert.throws(() => servingConfig(changed));
});

test('hashes deterministic gzip bytes and excludes ignored files', async t => {
  const { root, configPath } = await fixture(t);
  const first = await prepareFiles(configPath);
  t.after(first.cleanup);
  await utimes(join(root, 'dist/index.html'), 100, 200);
  const second = await prepareFiles(configPath);
  t.after(second.cleanup);
  assert.deepEqual(first.files.map(({ name, hash }) => ({ name, hash })), second.files.map(({ name, hash }) => ({ name, hash })));
  assert.equal(first.files.length, 2);
  for (const file of first.files) {
    const compressed = await readFile(first.byHash.get(file.hash));
    assert.equal(createHash('sha256').update(compressed).digest('hex'), file.hash);
    assert.equal(gunzipSync(compressed).toString(), await readFile(join(root, 'dist', file.name.slice(1)), 'utf8'));
  }
});

test('rejects missing index, repository escape, unsafe filenames and case collisions before network access', async t => {
  for (const [files, configuration] of [
    [{ 'other.html': 'x' }, config],
    [{ 'index.html': 'x' }, { hosting: { ...config.hosting, public: '../escape' } }],
    [{ 'index.html': 'x', 'bad%20name': 'x' }, config],
  ]) {
    const { configPath } = await fixture(t, files, configuration);
    const transport = protocol();
    await assert.rejects(publish(configPath, transport));
    assert.equal(transport.requests.length, 0);
  }
  if (process.platform !== 'win32') {
    const { configPath } = await fixture(t, { 'index.html': 'a', 'INDEX.html': 'b' });
    await assert.rejects(prepareFiles(configPath), /Duplicate/);
  }
});

test('rejects symbolic links and Windows junctions instead of publishing outside the artifact', async t => {
  const { root, configPath } = await fixture(t);
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside', 'private'), 'private');
  await symlink(join(root, 'outside'), join(root, 'dist', 'leak'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareFiles(configPath), /symlinks/);
});

test('publishes only an expiring preview, verifies gzip uploads, then finalizes before release', async t => {
  const { configPath } = await fixture(t);
  const transport = protocol();
  assert.deepEqual(await publish(configPath, transport), { channel, version, files: 2, uploaded: 2 });
  assert.deepEqual([...transport.uploaded.values()].sort(), ['<html>release</html>', 'wasm payload'].sort());
  const methods = transport.requests.map(({ method }) => method);
  assert.deepEqual(methods, ['GET', 'POST', 'POST', 'POST', 'POST', 'POST', 'PATCH', 'POST']);
  assert.ok(transport.requests.every(({ url }) => !url.includes('/live')));
});

test('batches at 1000 files and limits uploads to three simultaneous streams', async t => {
  const files = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [index ? `assets/${index}.js` : 'index.html', String(index)]));
  const { configPath } = await fixture(t, files);
  const transport = protocol({ delayUpload: true });
  const result = await publish(configPath, transport);
  assert.equal(result.files, 1001);
  assert.deepEqual(transport.batches.map(batch => Object.keys(batch).length), [1000, 1]);
  assert.equal(transport.maximum, 3);
});

test('does not forward credentials to alternate upload hosts, ports, paths, queries, or redirects', () => {
  for (const url of [uploadUrl.replace('https:', 'http:'), uploadUrl.replace('.com/', '.com.evil/'), uploadUrl.replace('.com/', '.com:443/'), `${uploadUrl}?x=1`, `${uploadUrl}/`, uploadUrl.replace(version, 'sites/foreign/versions/other'), `https://user:password@upload-firebasehosting.googleapis.com/upload/${version}/files`]) {
    assert.throws(() => validateUploadUrl(url, version), /unexpected upload/);
  }
  assert.equal(validateUploadUrl(uploadUrl, version), uploadUrl);
});

test('rejects an existing channel, foreign version, unknown hash, wrong finalization, or foreign release', async t => {
  const { configPath } = await fixture(t);
  const existing = protocol();
  existing.fetchImpl = async () => json({ name: channel });
  await assert.rejects(publish(configPath, existing), /already exists/);
  for (const [stage, change, expected] of [
    ['channel', body => ({ ...body, expireTime: new Date(Date.now() + 30 * 86400_000).toISOString() }), /expected expiring channel/],
    ['version', body => ({ ...body, name: 'sites/foreign/versions/other' }), /unexpected version/],
    ['populate', body => ({ ...body, uploadRequiredHashes: ['a'.repeat(64)] }), /unknown asset hash/],
    ['populate', body => ({ ...body, uploadUrl: uploadUrl.replace('.com/', '.com.evil/') }), /unexpected upload/],
    ['finalize', body => ({ ...body, status: 'CREATED' }), /not finalized/],
    ['release', body => ({ ...body, version: { name: 'sites/foreign/versions/x', status: 'FINALIZED' } }), /did not bind/],
  ]) {
    const transport = protocol({ mutate: (body, current) => current === stage ? change(body) : body });
    await assert.rejects(publish(configPath, transport), expected);
  }
});

test('never retries ambiguous mutations and sanitizes transport errors', async t => {
  const { configPath } = await fixture(t);
  const transport = protocol({ fail: url => url.includes('/channels?') });
  await assert.rejects(publish(configPath, transport), error => {
    assert.match(error.message, /inspect server state/);
    assert.ok(!error.message.includes('private token'));
    return true;
  });
  assert.equal(transport.requests.length, 2);
});

test('rejects URL and regex metacharacters in server resource names before subsequent requests', async t => {
  const { configPath } = await fixture(t);
  for (const invalid of [
    `sites/${site}/versions/https://evil.example/upload`,
    `sites/${site}/versions/id?redirect=https://evil.example`,
    `sites/${site}/versions/id#fragment`,
    `sites/${site}/versions/id|.*`,
    `sites/${site}/versions/../other`,
  ]) {
    const transport = protocol({ mutate: (body, stage) => stage === 'version' ? { ...body, name: invalid } : body });
    await assert.rejects(publish(configPath, transport), /unexpected version/);
    assert.equal(transport.requests.length, 3);
    assert.ok(transport.requests.every(({ url }) => new URL(url).hostname === 'firebasehosting.googleapis.com'));
  }
  for (const invalid of [`${channel}/releases/123|.*`, `${channel}/releases/123/extra`, `sites/${site}/channels/foreign/releases/123`]) {
    const transport = protocol({ mutate: (body, stage) => stage === 'release' ? { ...body, name: invalid } : body });
    await assert.rejects(publish(configPath, transport), /did not bind/);
  }
});

test('wrong project, live channel and missing token cannot make requests', async t => {
  const { configPath } = await fixture(t);
  for (const override of [{ projectId: 'foreign' }, { siteId: 'foreign' }, { siteId: `${site}|.*` },
    { channelId: 'live' }, { channelId: 'gha-12-1|.*' }, { token: undefined }]) {
    const transport = protocol();
    await assert.rejects(publish(configPath, transport, override));
    assert.equal(transport.requests.length, 0);
  }
});
