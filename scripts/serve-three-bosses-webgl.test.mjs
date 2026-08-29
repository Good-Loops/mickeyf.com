import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { brotliCompressSync } from "node:zlib";
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
  await writeFile(join(rootPath, "Build", "test.framework.js.br"), brotliCompressSync("framework"));
  await writeFile(join(rootPath, "Build", "test.loader.js"), "loader");
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

test("writes a version-two marker only for the exact Brotli release file set", async () => {
  const releaseRoot = await mkdtemp(join(tmpdir(), "three-bosses-webgl-release-marker-"));
  const buildPath = join(releaseRoot, "Build");
  await mkdir(buildPath);
  try {
    await writeFile(join(buildPath, "release.loader.js"), "loader");
    await writeFile(join(buildPath, "release.data.br"), "data");
    await writeFile(join(buildPath, "release.framework.js.br"), "framework");
    await writeFile(join(buildPath, "release.wasm.br"), "wasm");
    await writeBuildCompletionMarker(releaseRoot, { provenance: releaseProvenance });

    const marker = JSON.parse(await readFile(
      join(releaseRoot, BUILD_COMPLETION_MARKER),
      "utf8",
    ));
    assert.equal(marker.version, 2);
    assert.deepEqual(marker.provenance, releaseProvenance);
    assert.match((await readBuildManifest(releaseRoot)).codeUrl, /[.]wasm[.]br[?]/u);
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
      /Brotli data/u,
    );
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test("rejects old asset URLs while a build is invalidated and after marker rollover", async () => {
  const oldManifest = await (await fetch(`${baseUrl}/build-manifest.json`)).json();
  const oldAssetPath = `/${oldManifest.codeUrl}`;

  await invalidateBuildCompletionMarker(rootPath);
  let response = await rawRequest(oldAssetPath);
  assert.equal(response.status, 503);

  await writeFile(join(rootPath, "Build", "test.data.br"), brotliCompressSync("replacement data"));
  await writeBuildCompletionMarker(rootPath);
  const newManifest = await readBuildManifest(rootPath);
  assert.notEqual(newManifest.buildId, oldManifest.buildId);

  response = await rawRequest(oldAssetPath);
  assert.equal(response.status, 409);
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
