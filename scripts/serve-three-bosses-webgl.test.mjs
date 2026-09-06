import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { after, before, test } from "node:test";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";
import {
  BUILD_COMPLETION_MARKER,
  invalidateBuildCompletionMarker,
  createThreeBossesWebGlServer,
  readBuildManifest,
  writeBuildCompletionMarker,
} from "./serve-three-bosses-webgl.mjs";

let rootPath;
let outsidePath;
let baseUrl;
let server;
let serverPort;
let buildId;
const loaderPayload = `${"loader".repeat(20000)}tail`;

const releaseProvenance = Object.freeze({
  sourceCommit: "a".repeat(40),
  unityEditorVersion: "6000.3.8f1",
  unitySourceDigest: "c".repeat(64),
  unitySourceFileCount: 5,
});

const rawRequest = (requestPath, { headers = {}, method = "GET", port = serverPort } = {}) =>
  new Promise((resolvePromise, reject) => {
    const clientRequest = request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolvePromise({
        body: Buffer.concat(chunks).toString("utf8"),
        bytes: Buffer.concat(chunks),
        headers: response.headers,
        status: response.statusCode,
      }));
    });
    clientRequest.on("error", reject);
    clientRequest.end();
  });

before(async () => {
  rootPath = await mkdtemp(join(tmpdir(), "three-bosses-webgl-root-"));
  outsidePath = await mkdtemp(join(tmpdir(), "three-bosses-webgl-outside-"));
  await mkdir(join(rootPath, "Build"));
  await writeFile(join(rootPath, "Build", "test.data.br"), brotliCompressSync("data"));
  await writeFile(join(rootPath, "Build", "test.wasm.br"), brotliCompressSync("wasm"));
  await writeFile(join(rootPath, "Build", "test.framework.js.gz"), gzipSync("framework"));
  await writeFile(join(rootPath, "Build", "test.loader.js"), loaderPayload);
  await writeFile(join(outsidePath, "secret.txt"), "secret");
  await symlink(
    outsidePath,
    join(rootPath, "Build", "escaped"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await writeBuildCompletionMarker(rootPath);
  buildId = (await readBuildManifest(rootPath)).buildId;

  server = createThreeBossesWebGlServer({ rootPath });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  serverPort = address.port;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    });
  }
  await rm(rootPath, { recursive: true, force: true });
  await rm(outsidePath, { recursive: true, force: true });
});

test("returns a synthetic manifest without absolute host paths", async () => {
  const response = await fetch(`${baseUrl}/build-manifest.json`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const manifest = await response.json();
  assert.equal(manifest.loaderUrl, `Build/test.loader.js?buildId=${manifest.buildId}`);
  assert.equal(manifest.dataUrl, `Build/test.data.br?buildId=${manifest.buildId}`);
  assert.match(manifest.buildId, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(manifest).includes(rootPath), false);
});

test("normalizes configured build roots but rejects filesystem roots and NUL bytes", async () => {
  const normalizedManifest = await readBuildManifest(join(rootPath, "Build", ".."));
  assert.equal(normalizedManifest.buildId, buildId);

  assert.throws(
    () => createThreeBossesWebGlServer({ rootPath: parse(tmpdir()).root }),
    /beneath the filesystem root/u,
  );
  assert.throws(
    () => createThreeBossesWebGlServer({ rootPath: `${rootPath}\0escape` }),
    /non-empty filesystem path/u,
  );
});

test("serves compressed WebAssembly with Unity-compatible headers", async () => {
  const response = await fetch(`${baseUrl}/Build/test.wasm.br?buildId=${buildId}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/wasm");
  assert.equal(response.headers.get("content-encoding"), "br");
  assert.equal(await response.text(), "wasm");
});

test("supports HEAD without sending an asset body", async () => {
  const response = await rawRequest(`/Build/test.wasm.br?buildId=${buildId}`, { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/wasm");
  assert.equal(response.headers["content-encoding"], "br");
  assert.equal(response.body, "");
});

test("streams gzip for raw Build assets without an incorrect content length", async () => {
  const response = await rawRequest(`/Build/test.loader.js?buildId=${buildId}`, {
    headers: { "Accept-Encoding": "gzip" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.equal(response.headers["content-length"], undefined);
  assert.equal(response.headers.vary, "Accept-Encoding");
  assert.equal(response.headers["cache-control"], "private, no-cache");
  assert.equal(gunzipSync(response.bytes).toString("utf8"), loaderPayload);
  assert.ok(response.bytes.length < Buffer.byteLength(loaderPayload));
});

test("streams every identity byte including the final partial chunk", async () => {
  const response = await rawRequest(`/Build/test.loader.js?buildId=${buildId}`);
  assert.equal(response.status, 200);
  assert.equal(response.bytes.length, Buffer.byteLength(loaderPayload));
  assert.equal(response.body, loaderPayload);
  assert.equal(response.headers["content-length"], String(response.bytes.length));
});

test("honors gzip exclusions and wildcard fallback", async () => {
  for (const [acceptEncoding, compressed] of [
    ["gzip;q=0", false],
    ["gzip;q=0, *;q=1", false],
    ["*;q=0", false],
    ["br", false],
    ["*;q=0.5", true],
    ["GZip; q=0.5", true],
    ["gzip;q=1, *;q=0", true],
  ]) {
    const response = await rawRequest(`/Build/test.loader.js?buildId=${buildId}`, {
      headers: { "Accept-Encoding": acceptEncoding },
    });
    assert.equal(response.status, 200, acceptEncoding);
    assert.equal(response.headers["content-encoding"], compressed ? "gzip" : undefined, acceptEncoding);
    assert.equal(
      compressed ? gunzipSync(response.bytes).toString("utf8") : response.body,
      loaderPayload,
      acceptEncoding,
    );
  }
});

test("keeps HEAD metadata consistent with identity and gzip representations", async () => {
  for (const acceptEncoding of ["identity", "gzip"]) {
    const path = `/Build/test.loader.js?buildId=${buildId}`;
    const headers = { "Accept-Encoding": acceptEncoding };
    const get = await rawRequest(path, { headers });
    const head = await rawRequest(path, { headers, method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    for (const name of ["content-type", "content-encoding", "content-length", "etag", "vary", "cache-control"]) {
      assert.equal(head.headers[name], get.headers[name], `${acceptEncoding}: ${name}`);
    }
    assert.equal(
      head.headers["content-length"],
      acceptEncoding === "identity" ? String(Buffer.byteLength(loaderPayload)) : undefined,
    );
  }
});

test("revalidates build assets using representation-specific ETags", async () => {
  const path = `/Build/test.loader.js?buildId=${buildId}`;
  const identity = await rawRequest(path);
  const gzip = await rawRequest(path, { headers: { "Accept-Encoding": "gzip" } });
  assert.ok(identity.headers.etag);
  assert.notEqual(identity.headers.etag, gzip.headers.etag);

  const cached = await rawRequest(path, {
    headers: { "Accept-Encoding": "gzip", "If-None-Match": `"other", ${gzip.headers.etag}` },
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.body, "");
  assert.equal(cached.headers.etag, gzip.headers.etag);
  assert.equal(cached.headers.vary, "Accept-Encoding");
  assert.equal(cached.headers["cache-control"], "private, no-cache");

  const differentRepresentation = await rawRequest(path, {
    headers: { "If-None-Match": gzip.headers.etag },
  });
  assert.equal(differentRepresentation.status, 200);
  assert.equal(differentRepresentation.body, loaderPayload);

  const cachedHead = await rawRequest(path, {
    headers: { "If-None-Match": identity.headers.etag },
    method: "HEAD",
  });
  assert.equal(cachedHead.status, 304);
  assert.equal(cachedHead.body, "");
});

test("serves precompressed files once with the correct encoding", async () => {
  for (const [name, encoding, decompress, expected] of [
    ["test.wasm.br", "br", brotliDecompressSync, "wasm"],
    ["test.framework.js.gz", "gzip", gunzipSync, "framework"],
  ]) {
    const response = await rawRequest(`/Build/${name}?buildId=${buildId}`, {
      headers: { "Accept-Encoding": "gzip, br" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], encoding);
    assert.equal(response.headers["content-length"], String(response.bytes.length));
    assert.equal(decompress(response.bytes).toString("utf8"), expected);
    assert.deepEqual(response.bytes, await readFile(join(rootPath, "Build", name)));
  }
});

test("keeps unversioned streaming assets uncached and uncompressed", async () => {
  await mkdir(join(rootPath, "StreamingAssets"));
  await writeFile(join(rootPath, "StreamingAssets", "settings.json"), "{}");
  const response = await rawRequest("/StreamingAssets/settings.json", {
    headers: { "Accept-Encoding": "gzip", "If-None-Match": "*" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.etag, undefined);
  assert.equal(response.headers["content-encoding"], undefined);
  assert.equal(response.body, "{}");
});

test("continues serving after a client aborts a streamed response", { timeout: 5000 }, async () => {
  await writeFile(join(rootPath, "StreamingAssets", "large.data"), Buffer.alloc(4 * 1024 * 1024, 42));
  await new Promise((resolvePromise, reject) => {
    const clientRequest = request({
      host: "127.0.0.1",
      port: serverPort,
      path: "/StreamingAssets/large.data",
    }, (response) => {
      response.once("data", () => {
        response.destroy();
        clientRequest.destroy();
        resolvePromise();
      });
      response.on("error", reject);
    });
    clientRequest.on("error", reject);
    clientRequest.end();
  });

  const response = await rawRequest(`/Build/test.loader.js?buildId=${buildId}`, {
    headers: { "Accept-Encoding": "gzip" },
  });
  assert.equal(response.status, 200);
  assert.equal(gunzipSync(response.bytes).toString("utf8"), loaderPayload);
});

test("rejects traversal and symlink escapes", async () => {
  for (const requestPath of [
    `/Build/%2e%2e/%2e%2e/secret.txt?buildId=${buildId}`,
    `/Build/%5c..%5csecret.txt?buildId=${buildId}`,
    `/Build/escaped/secret.txt?buildId=${buildId}`,
  ]) {
    const response = await rawRequest(requestPath);
    assert.equal(response.status, 404);
    assert.notEqual(response.body, "secret");
  }
});

test("serves only the manifest, Build, and StreamingAssets paths", async () => {
  await writeFile(join(rootPath, "index.html"), "not served");
  const response = await rawRequest("/index.html");
  assert.equal(response.status, 404);
  assert.equal(response.body.includes("not served"), false);
});

test("rejects mutating methods", async () => {
  const response = await fetch(`${baseUrl}/build-manifest.json`, { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});

test("rejects non-loopback Host headers", async () => {
  const response = await rawRequest("/build-manifest.json", {
    headers: { Host: "example.com" },
  });
  assert.equal(response.status, 421);
});

test("rejects Build asset requests without the manifest build ID", async () => {
  const response = await rawRequest("/Build/test.wasm.br");
  assert.equal(response.status, 409);
  assert.match(response.body, /STALE_BUILD/u);
});

test("rejects mismatched and partially refreshed build files", async () => {
  const incompleteRoot = await mkdtemp(join(tmpdir(), "three-bosses-webgl-incomplete-"));
  const buildPath = join(incompleteRoot, "Build");
  await mkdir(buildPath);

  try {
    await writeFile(join(buildPath, "old.loader.js"), "loader");
    await writeFile(join(buildPath, "new.data.br"), "data");
    await writeFile(join(buildPath, "new.framework.js.br"), "framework");
    await writeFile(join(buildPath, "new.wasm.br"), "wasm");
    await assert.rejects(() => readBuildManifest(incompleteRoot), /one build name/u);

    await rm(join(buildPath, "old.loader.js"));
    await writeFile(join(buildPath, "new.loader.js"), "loader");
    const oldTime = new Date("2026-01-01T00:00:00Z");
    const newTime = new Date("2026-01-02T00:00:00Z");
    await utimes(join(buildPath, "new.loader.js"), oldTime, oldTime);
    await utimes(join(buildPath, "new.framework.js.br"), oldTime, oldTime);
    await utimes(join(buildPath, "new.data.br"), newTime, newTime);
    await utimes(join(buildPath, "new.wasm.br"), newTime, newTime);
    await assert.rejects(() => readBuildManifest(incompleteRoot), /still being finalized/u);
  } finally {
    await rm(incompleteRoot, { recursive: true, force: true });
  }
});

test("accepts incremental output only after an exact completion marker", async () => {
  const incrementalRoot = await mkdtemp(join(tmpdir(), "three-bosses-webgl-incremental-"));
  const buildPath = join(incrementalRoot, "Build");
  await mkdir(buildPath);

  try {
    await writeFile(join(buildPath, "incremental.loader.js"), "loader");
    await writeFile(join(buildPath, "incremental.framework.js.br"), "framework");
    await writeFile(join(buildPath, "incremental.data.br"), "new data");
    await writeFile(join(buildPath, "incremental.wasm.br"), "wasm");
    const oldTime = new Date("2026-01-01T00:00:00Z");
    const newTime = new Date("2026-01-02T00:00:00Z");
    await utimes(join(buildPath, "incremental.loader.js"), oldTime, oldTime);
    await utimes(join(buildPath, "incremental.framework.js.br"), oldTime, oldTime);
    await utimes(join(buildPath, "incremental.wasm.br"), oldTime, oldTime);
    await utimes(join(buildPath, "incremental.data.br"), newTime, newTime);

    await assert.rejects(() => readBuildManifest(incrementalRoot), /still being finalized/u);
    await writeBuildCompletionMarker(incrementalRoot);
    const manifest = await readBuildManifest(incrementalRoot);
    assert.match(manifest.dataUrl, new RegExp(`buildId=${manifest.buildId}$`, "u"));

    await writeFile(join(buildPath, "incremental.data.br"), "new data changed");
    await assert.rejects(() => readBuildManifest(incrementalRoot), /still being finalized/u);

    await invalidateBuildCompletionMarker(incrementalRoot);
    await assert.rejects(() => readBuildManifest(incrementalRoot), /still being finalized/u);
  } finally {
    await rm(incrementalRoot, { recursive: true, force: true });
  }
});

test("writes a version-two marker only for the exact uncompressed release file set", async () => {
  const releaseRoot = await mkdtemp(join(tmpdir(), "three-bosses-webgl-release-marker-"));
  const buildPath = join(releaseRoot, "Build");
  await mkdir(buildPath);
  try {
    await writeFile(join(buildPath, "release.loader.js"), "loader");
    await writeFile(join(buildPath, "release.data"), "data");
    await writeFile(join(buildPath, "release.framework.js"), "framework");
    await writeFile(join(buildPath, "release.wasm"), "wasm");
    await writeBuildCompletionMarker(releaseRoot, { provenance: releaseProvenance });

    const marker = JSON.parse(await readFile(
      join(releaseRoot, BUILD_COMPLETION_MARKER),
      "utf8",
    ));
    assert.equal(marker.version, 2);
    assert.deepEqual(marker.provenance, releaseProvenance);
    assert.match((await readBuildManifest(releaseRoot)).codeUrl, /[.]wasm[?]/u);
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test("rejects gzip assets when writing a release completion marker", async () => {
  const releaseRoot = await mkdtemp(join(tmpdir(), "three-bosses-webgl-release-gzip-"));
  const buildPath = join(releaseRoot, "Build");
  await mkdir(buildPath);
  try {
    await writeFile(join(buildPath, "release.loader.js"), "loader");
    await writeFile(join(buildPath, "release.data.gz"), "data");
    await writeFile(join(buildPath, "release.framework.js.gz"), "framework");
    await writeFile(join(buildPath, "release.wasm.gz"), "wasm");
    await assert.rejects(
      () => writeBuildCompletionMarker(releaseRoot, { provenance: releaseProvenance }),
      /uncompressed data/u,
    );
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test("rejects Brotli assets when writing a release completion marker", async () => {
  const releaseRoot = await mkdtemp(join(tmpdir(), "three-bosses-webgl-release-brotli-"));
  const buildPath = join(releaseRoot, "Build");
  await mkdir(buildPath);
  try {
    await writeFile(join(buildPath, "release.loader.js"), "loader");
    await writeFile(join(buildPath, "release.data.br"), "data");
    await writeFile(join(buildPath, "release.framework.js.br"), "framework");
    await writeFile(join(buildPath, "release.wasm.br"), "wasm");
    await assert.rejects(
      () => writeBuildCompletionMarker(releaseRoot, { provenance: releaseProvenance }),
      /uncompressed data/u,
    );
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test("rejects old asset URLs while a build is invalidated and after marker rollover", async () => {
  const oldManifest = await (await fetch(`${baseUrl}/build-manifest.json`)).json();
  const oldAssetPath = `/${oldManifest.codeUrl}`;
  const cachedAsset = await rawRequest(oldAssetPath);
  const conditionalHeaders = { "If-None-Match": cachedAsset.headers.etag };

  const oldWasmPath = join(rootPath, "Build", "test.wasm.br");
  await writeFile(oldWasmPath, brotliCompressSync("replacement wasm"));
  let response = await rawRequest(oldAssetPath, { headers: conditionalHeaders });
  assert.equal(response.status, 409);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.etag, undefined);

  await invalidateBuildCompletionMarker(rootPath);
  response = await rawRequest(oldAssetPath, { headers: conditionalHeaders });
  assert.equal(response.status, 503);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.etag, undefined);

  await writeFile(join(rootPath, "Build", "test.data.br"), brotliCompressSync("replacement data"));
  await writeBuildCompletionMarker(rootPath);
  const newManifest = await readBuildManifest(rootPath);
  assert.notEqual(newManifest.buildId, oldManifest.buildId);

  response = await rawRequest(oldAssetPath, { headers: conditionalHeaders });
  assert.equal(response.status, 409);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.etag, undefined);
  assert.match(response.body, /STALE_BUILD/u);
});

test("sanitizes missing-build responses", async () => {
  const missingRoot = join(rootPath, "missing-build");
  const missingServer = createThreeBossesWebGlServer({ rootPath: missingRoot });
  await new Promise((resolvePromise) => missingServer.listen(0, "127.0.0.1", resolvePromise));

  try {
    const address = missingServer.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/build-manifest.json`);
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.equal(body.includes(rootPath), false);
    assert.match(body, /No complete Unity WebGL build/u);
  } finally {
    await new Promise((resolvePromise, reject) => {
      missingServer.close((error) => error ? reject(error) : resolvePromise());
    });
  }
});
