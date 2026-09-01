import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  resolveApprovedHostedBaseUrl,
  verifyHostedThreeBossesWebGlRelease,
} from "./verify-three-bosses-webgl-hosting.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const buildId = "a".repeat(64);
const runtimeFiles = new Map([
  ["Build/game.loader.js", Buffer.from("loader\n")],
  ["Build/game.data", Buffer.from("data\n")],
  ["Build/game.framework.js", Buffer.from("framework\n")],
  ["Build/game.wasm", Buffer.from("wasm\n")],
]);

let root;
let manifestPath;
let manifestBytes;
let server;
let baseUrl;
let mutateResponse;
let transientManifestFailures;

const verifyRelease = (overrides = {}) => verifyHostedThreeBossesWebGlRelease({
  baseUrl,
  manifestPath,
  allowLoopbackForTests: true,
  ...overrides,
});

const headersFor = (relativePath) => {
  const headers = { "Cache-Control": "public, max-age=31536000, immutable" };
  if (relativePath.endsWith(".loader.js")) {
    headers["Content-Type"] = "text/javascript; charset=utf-8";
  } else if (relativePath.endsWith(".data")) {
    headers["Content-Type"] = "application/octet-stream";
  } else if (relativePath.endsWith(".framework.js")) {
    headers["Content-Type"] = "text/javascript; charset=utf-8";
  } else {
    headers["Content-Type"] = "application/wasm";
  }
  return headers;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "three-bosses-hosted-verifier-"));
  manifestPath = join(root, "build-manifest.json");
  const manifest = {
    version: 2,
    buildId,
    assets: [...runtimeFiles].map(([relativePath, body]) => ({
      path: `releases/${buildId}/${relativePath}`,
      sha256: sha256(body),
      size: body.length,
    })),
  };
  manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, manifestBytes);
  mutateResponse = null;
  transientManifestFailures = 0;

  server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/unity/three-bosses/build-manifest.json") {
      if (transientManifestFailures > 0) {
        transientManifestFailures -= 1;
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'",
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(manifestBytes);
      return;
    }

    const prefix = `/unity/three-bosses/releases/${buildId}/`;
    const relativePath = url.pathname.startsWith(prefix)
      ? decodeURIComponent(url.pathname.slice(prefix.length))
      : null;
    const originalBody = relativePath ? runtimeFiles.get(relativePath) : null;
    if (!originalBody) {
      response.writeHead(404).end();
      return;
    }
    const hosted = mutateResponse?.(relativePath, {
      body: originalBody,
      headers: headersFor(relativePath),
    }) ?? { body: originalBody, headers: headersFor(relativePath) };
    response.writeHead(200, hosted.headers);
    response.end(hosted.body);
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
  if (root) await rm(root, { force: true, recursive: true });
});

test("verifies every hosted runtime byte and required header", async () => {
  const result = await verifyRelease();
  assert.deepEqual(result, { assetCount: 4, buildId });
});

test("canonicalizes the exact live and project-specific Firebase preview origins", () => {
  assert.equal(
    resolveApprovedHostedBaseUrl("https://mickeyf.com").href,
    "https://mickeyf.com/",
  );
  assert.equal(
    resolveApprovedHostedBaseUrl(
      "https://noted-reef-387021--gha-123-4-a1b2c3.web.app",
    ).href,
    "https://noted-reef-387021--gha-123-4-a1b2c3.web.app/",
  );
});

test("rejects a hosted runtime byte mismatch", async () => {
  mutateResponse = (relativePath, response) => relativePath.endsWith(".wasm")
    ? { ...response, body: Buffer.from("evil\n") }
    : response;
  await assert.rejects(
    () => verifyRelease(),
    /does not match its manifest/u,
  );
});

test("rejects an immutable runtime with a weak cache policy", async () => {
  mutateResponse = (relativePath, response) => relativePath.endsWith(".data")
    ? { ...response, headers: { ...response.headers, "Cache-Control": "no-cache" } }
    : response;
  await assert.rejects(
    () => verifyRelease(),
    /missing Cache-Control public/u,
  );
});

test("rejects a manifest with directives that weaken no-store", async () => {
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/unity/three-bosses/build-manifest.json") {
      response.writeHead(200, {
        "Cache-Control": "no-store, no-cache",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'",
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(manifestBytes);
      return;
    }
    response.writeHead(404).end();
  });

  await assert.rejects(
    () => verifyRelease(),
    /conflicting cache policy/u,
  );
});

test("rejects a runtime that ignores the identity encoding request", async () => {
  mutateResponse = (relativePath, response) => relativePath.endsWith(".framework.js")
    ? {
        ...response,
        headers: { ...response.headers, "Content-Encoding": "gzip" },
      }
    : response;
  await assert.rejects(
    () => verifyRelease(),
    /must honor identity encoding/u,
  );
});

test("retries a transient hosted response without weakening verification", async () => {
  transientManifestFailures = 1;
  const result = await verifyRelease();
  assert.deepEqual(result, { assetCount: 4, buildId });
});

test("rejects a deployment that cannot compile the Unity WebAssembly runtime", async () => {
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/unity/three-bosses/build-manifest.json") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'",
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(manifestBytes);
      return;
    }
    response.writeHead(404).end();
  });

  await assert.rejects(
    () => verifyRelease(),
    /must allow wasm-unsafe-eval/u,
  );
});

test("rejects unapproved and structurally ambiguous deployment origins", async () => {
  for (const untrustedBaseUrl of [
    "http://169.254.169.254",
    "https://mickeyf.com.attacker.example",
    "https://user@mickeyf.com",
    "https://mickeyf.com:8443",
    "https://mickeyf.com/unexpected",
    "https://noted-reef-387021--foreign-preview.web.app",
  ]) {
    await assert.rejects(
      () => verifyHostedThreeBossesWebGlRelease({
        baseUrl: untrustedBaseUrl,
        manifestPath,
      }),
      /invalid|exact trusted origin|not an approved deployment origin/u,
    );
  }
});

test("permits loopback only through the explicit test boundary", async () => {
  await assert.rejects(
    () => verifyHostedThreeBossesWebGlRelease({ baseUrl, manifestPath }),
    /not an approved deployment origin/u,
  );
  const result = await verifyRelease();
  assert.deepEqual(result, { assetCount: 4, buildId });
});
