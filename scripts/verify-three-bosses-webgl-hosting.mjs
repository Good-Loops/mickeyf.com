import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultManifestPath = resolve(
  scriptDirectory,
  "..",
  "frontend",
  "dist",
  "unity",
  "three-bosses",
  "build-manifest.json",
);
const hashPattern = /^[a-f0-9]{64}$/u;
const firebasePreviewHostPattern =
  /^noted-reef-387021--gha-[1-9][0-9]*-[1-9][0-9]*-[a-z0-9]+[.]web[.]app$/u;
const liveOrigin = "https://mickeyf.com";
const retryDelaysMs = [500, 1_500, 3_000];
const retryableHttpStatuses = new Set([502, 503, 504]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const parseCacheControl = (value) => new Set(String(value ?? "")
  .split(",")
  .map((directive) => directive.trim().toLowerCase())
  .filter(Boolean));

const parseContentSecurityPolicy = (value) => new Map(String(value ?? "")
  .split(";")
  .map((directive) => directive.trim().split(/\s+/u).filter(Boolean))
  .filter((parts) => parts.length > 0)
  .map(([name, ...sources]) => [name.toLowerCase(), new Set(sources)]));

const requireHeader = (headers, name) => {
  const value = headers[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Hosted WebGL response is missing ${name}.`);
  }
  return value;
};

const assertManifestHeaders = (headers) => {
  const cacheControl = parseCacheControl(requireHeader(headers, "cache-control"));
  if (!cacheControl.has("no-store")) {
    throw new Error("Hosted WebGL manifest must be served with no-store.");
  }
  if (["public", "immutable", "no-cache", "max-age=0", "must-revalidate", "private"]
    .some((directive) => cacheControl.has(directive))) {
    throw new Error("Hosted WebGL manifest has a conflicting cache policy.");
  }
  const contentType = requireHeader(headers, "content-type").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new Error("Hosted WebGL manifest must be served as JSON.");
  }

  const policy = parseContentSecurityPolicy(
    requireHeader(headers, "content-security-policy"),
  );
  const scriptSources = policy.get("script-src");
  if (!scriptSources?.has("'wasm-unsafe-eval'")) {
    throw new Error(
      "Hosted WebGL Content-Security-Policy must allow wasm-unsafe-eval in script-src.",
    );
  }
  if (scriptSources.has("'unsafe-eval'")) {
    throw new Error(
      "Hosted WebGL Content-Security-Policy must not allow unrestricted unsafe-eval.",
    );
  }
};

const assertImmutableHeaders = (headers) => {
  const cacheControl = parseCacheControl(requireHeader(headers, "cache-control"));
  for (const directive of ["public", "max-age=31536000", "immutable"]) {
    if (!cacheControl.has(directive)) {
      throw new Error(`Hosted WebGL asset is missing Cache-Control ${directive}.`);
    }
  }
  if (["no-store", "no-cache", "max-age=0", "must-revalidate", "private"]
    .some((directive) => cacheControl.has(directive))) {
    throw new Error("Hosted WebGL immutable asset has a conflicting cache policy.");
  }
};

const assertRuntimeHeaders = (assetPath, headers) => {
  if (assetPath.endsWith(".loader.js")) {
    if (headers["content-encoding"] !== undefined) {
      throw new Error("Hosted WebGL loader must remain uncompressed for hash verification.");
    }
    const type = requireHeader(headers, "content-type").toLowerCase();
    if (!type.startsWith("text/javascript") && !type.startsWith("application/javascript")) {
      throw new Error("Hosted WebGL loader has an invalid JavaScript content type.");
    }
    return;
  }

  const expected = assetPath.endsWith(".data.br")
    ? "application/octet-stream"
    : assetPath.endsWith(".framework.js.br")
      ? "text/javascript"
      : assetPath.endsWith(".wasm.br")
        ? "application/wasm"
        : null;
  if (expected === null) return;
  if (requireHeader(headers, "content-encoding").toLowerCase() !== "br") {
    throw new Error("Hosted WebGL Brotli runtime asset is missing Content-Encoding br.");
  }
  const type = requireHeader(headers, "content-type").toLowerCase();
  const javascriptCompatible = expected === "text/javascript"
    && type.startsWith("application/javascript");
  if (!type.startsWith(expected) && !javascriptCompatible) {
    throw new Error(`Hosted WebGL runtime asset must be served as ${expected}.`);
  }
};

const validateLocalManifest = (manifest) => {
  if (!manifest || manifest.version !== 2 || !hashPattern.test(manifest.buildId ?? "")) {
    throw new Error("Local WebGL manifest is invalid.");
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new Error("Local WebGL manifest has no assets.");
  }

  const prefix = `releases/${manifest.buildId}/`;
  const seen = new Set();
  for (const asset of manifest.assets) {
    if (!asset || typeof asset.path !== "string"
        || !asset.path.startsWith(prefix)
        || asset.path.includes("\\")
        || asset.path.split("/").some((segment) => !segment || segment === "." || segment === "..")
        || !hashPattern.test(asset.sha256 ?? "")
        || !Number.isSafeInteger(asset.size)
        || asset.size < 1
        || seen.has(asset.path)) {
      throw new Error("Local WebGL manifest contains an unsafe or invalid asset.");
    }
    seen.add(asset.path);
  }
};

const encodeManifestAssetPath = (assetPath) => assetPath
  .split("/")
  .map((segment) => encodeURIComponent(segment))
  .join("/");

export const resolveApprovedHostedBaseUrl = (
  baseUrl,
  { allowLoopbackForTests = false } = {},
) => {
  if (typeof baseUrl !== "string" || baseUrl.length === 0 || baseUrl.length > 512) {
    throw new Error("Hosted WebGL base URL is invalid.");
  }

  let candidate;
  try {
    candidate = new URL(baseUrl);
  } catch {
    throw new Error("Hosted WebGL base URL is invalid.");
  }
  if (candidate.username || candidate.password || candidate.pathname !== "/"
      || candidate.search || candidate.hash) {
    throw new Error("Hosted WebGL base URL must be an exact trusted origin.");
  }

  if (candidate.origin === liveOrigin) return new URL(`${liveOrigin}/`);

  const previewHost = firebasePreviewHostPattern.exec(candidate.hostname)?.[0];
  if (candidate.protocol === "https:" && candidate.port === "" && previewHost) {
    // The anchored allowlist above limits this to the Firebase channel that this
    // repository creates. Encoding is intentionally redundant for that alphabet,
    // but also makes the trust transition explicit to static request-flow analysis.
    const trustedPreviewHost = encodeURIComponent(previewHost);
    return new URL(`https://${trustedPreviewHost}/`);
  }

  const loopbackPort = Number(candidate.port);
  if (allowLoopbackForTests === true
      && candidate.protocol === "http:"
      && candidate.hostname === "127.0.0.1"
      && Number.isInteger(loopbackPort)
      && loopbackPort >= 1
      && loopbackPort <= 65_535) {
    return new URL(`http://127.0.0.1:${loopbackPort}/`);
  }

  throw new Error("Hosted WebGL base URL is not an approved deployment origin.");
};

const transportError = (message, cause) => {
  const error = new Error(message, cause ? { cause } : undefined);
  error.retryable = true;
  return error;
};

const requestRawOnce = (
  url,
  { acceptEncoding = "identity", maxBytes, timeoutMs = 120_000 } = {},
) => new Promise(
  (resolvePromise, reject) => {
    const client = url.protocol === "https:" ? httpsRequest : httpRequest;
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      reject(new Error("Hosted WebGL URL must use HTTP or HTTPS."));
      return;
    }

    const request = client(url, {
      headers: {
        "Accept-Encoding": acceptEncoding,
        "User-Agent": "mickeyf-three-bosses-release-verifier/1",
      },
      method: "GET",
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        const error = new Error(
          `Hosted WebGL request returned HTTP ${response.statusCode ?? "unknown"}.`,
        );
        error.retryable = retryableHttpStatuses.has(response.statusCode);
        reject(error);
        return;
      }

      const hash = createHash("sha256");
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (Number.isSafeInteger(maxBytes) && size > maxBytes) {
          const error = new Error("Hosted WebGL response exceeds its expected size.");
          error.retryable = false;
          response.destroy(error);
          return;
        }
        hash.update(chunk);
        chunks.push(chunk);
      });
      response.on("error", (error) => {
        reject(error.retryable === false
          ? error
          : transportError("Hosted WebGL response transport failed.", error));
      });
      response.on("end", () => resolvePromise({
        body: Buffer.concat(chunks),
        headers: response.headers,
        sha256: hash.digest("hex"),
        size,
      }));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(transportError("Hosted WebGL request timed out."));
    });
    request.on("error", (error) => reject(
      error.retryable === true
        ? error
        : transportError("Hosted WebGL request transport failed.", error),
    ));
    request.end();
  },
);

const requestRaw = async (url, options) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestRawOnce(url, options);
    } catch (error) {
      const retryDelayMs = retryDelaysMs[attempt];
      if (error.retryable !== true || retryDelayMs === undefined) throw error;
      await wait(retryDelayMs);
    }
  }
};

export const verifyHostedThreeBossesWebGlRelease = async ({
  baseUrl,
  manifestPath = defaultManifestPath,
  allowLoopbackForTests = false,
} = {}) => {
  const base = resolveApprovedHostedBaseUrl(baseUrl, { allowLoopbackForTests });

  const localManifestBytes = await readFile(resolve(manifestPath));
  const manifest = JSON.parse(localManifestBytes.toString("utf8"));
  validateLocalManifest(manifest);

  const manifestUrl = new URL("/unity/three-bosses/build-manifest.json", base);
  manifestUrl.searchParams.set("release", manifest.buildId);
  const hostedManifest = await requestRaw(manifestUrl, {
    maxBytes: localManifestBytes.length,
  });
  if (hostedManifest.size !== localManifestBytes.length
      || hostedManifest.sha256 !== sha256(localManifestBytes)) {
    throw new Error("Hosted WebGL manifest does not match the verified deployment artifact.");
  }
  assertManifestHeaders(hostedManifest.headers);

  const assetBase = new URL("/unity/three-bosses/", base);
  for (const asset of manifest.assets) {
    const trustedAssetPath = encodeManifestAssetPath(asset.path);
    const hostedAsset = await requestRaw(new URL(trustedAssetPath, assetBase), {
      acceptEncoding: asset.path.endsWith(".br") ? "br" : "identity",
      maxBytes: asset.size,
    });
    if (hostedAsset.size !== asset.size || hostedAsset.sha256 !== asset.sha256) {
      throw new Error(`Hosted WebGL asset does not match its manifest: ${asset.path}.`);
    }
    assertImmutableHeaders(hostedAsset.headers);
    assertRuntimeHeaders(asset.path, hostedAsset.headers);
  }

  return { assetCount: manifest.assets.length, buildId: manifest.buildId };
};

const parseArguments = (args) => {
  let baseUrl;
  let manifestPath = defaultManifestPath;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--base-url") {
      baseUrl = args[index += 1];
    } else if (argument === "--manifest") {
      manifestPath = args[index += 1];
    } else {
      throw new Error(`Unknown hosted WebGL verification argument: ${argument}.`);
    }
    if (typeof args[index] !== "string" || args[index].length === 0) {
      throw new Error(`${argument} requires a value.`);
    }
  }
  if (!baseUrl) throw new Error("--base-url is required.");
  return { baseUrl, manifestPath };
};

export const runHostedThreeBossesWebGlVerificationCli = async ({
  args = process.argv.slice(2),
} = {}) => verifyHostedThreeBossesWebGlRelease(parseArguments(args));

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const result = await runHostedThreeBossesWebGlVerificationCli();
    console.log(
      `Verified hosted Three Bosses WebGL release ${result.buildId} (${result.assetCount} assets).`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
