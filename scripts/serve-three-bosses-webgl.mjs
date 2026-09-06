import { createServer as createHttpServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { normalizeUnityBuildProvenance } from "./three-bosses-unity-provenance.mjs";

export const LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4174;
export const BUILD_COMPLETION_MARKER = ".mickeyf-webgl-build-complete.json";

const defaultRoot = () => {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is unavailable; set THREE_BOSSES_WEBGL_DIR explicitly.");
  }

  return join(localAppData, "mickeyf.com", "three-bosses-webgl");
};

const contentTypes = new Map([
  [".data", "application/octet-stream"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

const normalizeConfiguredRootPath = (rootPath) => {
  if (typeof rootPath !== "string" || !rootPath || rootPath.includes("\0")) {
    throw new TypeError("The Unity WebGL root must be a non-empty filesystem path.");
  }

  const normalizedRootPath = resolve(rootPath);
  const volumeRoot = parse(normalizedRootPath).root;
  const fromVolumeRoot = relative(volumeRoot, normalizedRootPath);
  if (
    !fromVolumeRoot
    || fromVolumeRoot === ".."
    || fromVolumeRoot.startsWith(`..${sep}`)
    || isAbsolute(fromVolumeRoot)
  ) {
    throw new Error("The Unity WebGL root must name a directory beneath the filesystem root.");
  }

  return normalizedRootPath;
};

const setCommonHeaders = (response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
};

const isAllowedHost = (hostHeader) => {
  if (typeof hostHeader !== "string" || !hostHeader) return false;

  try {
    const hostname = new URL(`http://${hostHeader}`).hostname;
    return hostname === LOOPBACK_HOST || hostname === "localhost";
  } catch {
    return false;
  }
};

const sendJson = (response, statusCode, payload, method = "GET") => {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  response.statusCode = statusCode;
  setCommonHeaders(response);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", body.byteLength);
  response.end(method === "HEAD" ? undefined : body);
};

const selectOne = (entries, description, pattern) => {
  const matches = entries.filter((entry) => pattern.test(entry));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${description}; found ${matches.length}.`);
  }
  return matches[0];
};

const buildStem = (fileName) => fileName.replace(
  /\.(?:loader\.js|data(?:\.br|\.gz)?|framework\.js(?:\.br|\.gz)?|wasm(?:\.br|\.gz)?)$/u,
  "",
);

const inspectBuildFiles = async (rootPath) => {
  const configuredRootPath = normalizeConfiguredRootPath(rootPath);
  const buildDirectory = join(configuredRootPath, "Build");
  const entries = (await readdir(buildDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

  const loader = selectOne(entries, "Unity loader", /\.loader\.js$/u);
  const data = selectOne(entries, "Unity data file", /\.data(?:\.br|\.gz)?$/u);
  const framework = selectOne(entries, "Unity framework", /\.framework\.js(?:\.br|\.gz)?$/u);
  const code = selectOne(entries, "Unity WebAssembly file", /\.wasm(?:\.br|\.gz)?$/u);
  const files = [loader, data, framework, code];
  const stems = new Set(files.map(buildStem));
  if (stems.size !== 1 || stems.has("")) {
    throw new Error("Unity WebGL build files do not share one build name.");
  }

  const fileStats = await Promise.all(
    files.map(async (fileName) => ({
      fileName,
      stats: await stat(join(buildDirectory, fileName)),
    })),
  );
  if (fileStats.some(({ stats }) => !stats.isFile() || stats.size <= 0)) {
    throw new Error("Unity WebGL build contains an empty or invalid file.");
  }

  return {
    buildDirectory,
    code,
    data,
    fileStats,
    framework,
    loader,
    rootPath: configuredRootPath,
  };
};

const assertReleaseRuntimeFiles = ({ code, data, framework, loader }) => {
  const expected = [
    [loader, /[.]loader[.]js$/u, "loader .loader.js"],
    [data, /[.]data$/u, "uncompressed data .data"],
    [framework, /[.]framework[.]js$/u, "uncompressed framework .framework.js"],
    [code, /[.]wasm$/u, "uncompressed WebAssembly .wasm"],
  ];
  for (const [fileName, pattern, label] of expected) {
    if (!pattern.test(fileName)) {
      throw new Error(`Release WebGL build requires exactly one ${label} asset.`);
    }
  }
};

const completionMarkerPayload = async (buildDirectory, fileStats, provenance) => {
  const files = await Promise.all(fileStats.map(async ({ fileName, stats }) => ({
    fileName,
    hash: createHash("sha256").update(await readFile(join(buildDirectory, fileName))).digest("hex"),
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  })));
  const buildId = createHash("sha256")
    .update(files.map(({ fileName, hash, size }) => `${fileName}:${size}:${hash}`).join("|"))
    .digest("hex");
  if (!provenance) return { buildId, files, version: 1 };
  return {
    buildId,
    files,
    provenance: normalizeUnityBuildProvenance(provenance),
    version: 2,
  };
};

const completionMarkerMatches = (marker, expected) => {
  if (![1, 2].includes(marker?.version) || !Array.isArray(marker.files)) return false;
  if (marker.version === 2) {
    try {
      normalizeUnityBuildProvenance(marker.provenance);
    } catch {
      return false;
    }
  }
  return marker.buildId === expected.buildId
    && expected.files.length === marker.files.length
    && expected.files.every((file, index) =>
    file.fileName === marker.files[index]?.fileName
    && file.hash === marker.files[index]?.hash
    && file.size === marker.files[index]?.size
    && file.mtimeMs === marker.files[index]?.mtimeMs);
};

const readCompletionMarker = async (rootPath) => {
  const configuredRootPath = normalizeConfiguredRootPath(rootPath);
  try {
    return {
      exists: true,
      value: JSON.parse(await readFile(
        join(configuredRootPath, BUILD_COMPLETION_MARKER),
        "utf8",
      )),
    };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, value: null };
    return { exists: true, value: null };
  }
};

export const invalidateBuildCompletionMarker = async (rootPath) => {
  const configuredRootPath = normalizeConfiguredRootPath(rootPath);
  await unlink(join(configuredRootPath, BUILD_COMPLETION_MARKER)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
};

export const writeBuildCompletionMarker = async (rootPath, { provenance } = {}) => {
  const buildFiles = await inspectBuildFiles(rootPath);
  if (provenance) assertReleaseRuntimeFiles(buildFiles);
  const { buildDirectory, fileStats, rootPath: configuredRootPath } = buildFiles;
  const payload = await completionMarkerPayload(buildDirectory, fileStats, provenance);
  const markerPath = join(configuredRootPath, BUILD_COMPLETION_MARKER);
  const temporaryPath = join(
    configuredRootPath,
    `.${BUILD_COMPLETION_MARKER}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(payload)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await rename(temporaryPath, markerPath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
};

export const readBuildManifest = async (rootPath) => {
  const {
    buildDirectory,
    code,
    data,
    fileStats,
    files,
    framework,
    loader,
    rootPath: configuredRootPath,
  } = await inspectBuildFiles(rootPath);

  // The marker is removed before a guarded build and rewritten atomically only
  // after Unity and repository cleanup succeed. Requiring it keeps same-name
  // incremental builds fail-closed while payload files are being replaced.
  const marker = await readCompletionMarker(configuredRootPath);
  const expectedMarker = await completionMarkerPayload(buildDirectory, fileStats);
  if (!marker.exists || !completionMarkerMatches(marker.value, expectedMarker)) {
    throw new Error("Unity WebGL build is still being finalized.");
  }

  const buildId = expectedMarker.buildId;
  const toUrl = (fileName) => `Build/${encodeURIComponent(fileName)}?buildId=${buildId}`;

  return {
    buildId,
    loaderUrl: toUrl(loader),
    dataUrl: toUrl(data),
    frameworkUrl: toUrl(framework),
    codeUrl: toUrl(code),
    streamingAssetsUrl: "StreamingAssets",
    companyName: "DefaultCompany",
    productName: "Three Bosses",
    productVersion: "1.0",
  };
};

const resolveRequestFile = async (rootPath, requestPath) => {
  const decoded = decodeURIComponent(requestPath);
  if (decoded.includes("\0") || decoded.includes("\\")) return null;

  const relativePath = normalize(decoded).replace(/^[/\\]+/u, "");
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(sep).includes("..")) {
    return null;
  }

  const configuredRootPath = normalizeConfiguredRootPath(rootPath);
  const rootRealPath = await realpath(configuredRootPath);
  const candidatePath = resolve(rootRealPath, relativePath);
  const candidateRealPath = await realpath(candidatePath);
  const fromRoot = relative(rootRealPath, candidateRealPath);

  if (!fromRoot || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return null;
  if (!(await stat(candidateRealPath)).isFile()) return null;
  return candidateRealPath;
};

const getContentMetadata = (filePath) => {
  let sourcePath = filePath;
  let contentEncoding;
  const compressionExtension = extname(sourcePath).toLowerCase();

  if (compressionExtension === ".br" || compressionExtension === ".gz") {
    contentEncoding = compressionExtension === ".gz" ? "gzip" : "br";
    sourcePath = sourcePath.slice(0, -compressionExtension.length);
  }

  return {
    contentEncoding,
    contentType: contentTypes.get(extname(sourcePath).toLowerCase()) ?? "application/octet-stream",
  };
};

const acceptsGzip = (acceptEncoding) => {
  if (typeof acceptEncoding !== "string") return false;

  const qualities = new Map(acceptEncoding.toLowerCase().split(",").map((entry) => {
    const [encoding, ...parameters] = entry.trim().split(";");
    const qualityParameter = parameters.find((parameter) => /^\s*q\s*=/u.test(parameter));
    const quality = qualityParameter === undefined ? 1 : Number(qualityParameter.split("=")[1]);
    return [encoding.trim(), quality >= 0 && quality <= 1 ? quality : 0];
  }));
  return (qualities.get("gzip") ?? qualities.get("*") ?? 0) > 0;
};

const matchesEtag = (ifNoneMatch, etag) => typeof ifNoneMatch === "string"
  && ifNoneMatch.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value.replace(/^W\//u, "") === etag.replace(/^W\//u, "");
  });

export const createThreeBossesWebGlServer = ({ rootPath = defaultRoot() } = {}) => {
  const configuredRootPath = normalizeConfiguredRootPath(rootPath);
  return createHttpServer(async (request, response) => {
    const method = request.method ?? "GET";
    if (!isAllowedHost(request.headers.host)) {
      sendJson(response, 421, { error: "INVALID_HOST" }, method);
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" }, method);
      return;
    }

    let requestUrl;
    try {
      requestUrl = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
    } catch {
      sendJson(response, 400, { error: "INVALID_URL" }, method);
      return;
    }

    if (requestUrl.pathname === "/build-manifest.json") {
      try {
        sendJson(response, 200, await readBuildManifest(configuredRootPath), method);
      } catch {
        sendJson(response, 503, {
          error: "BUILD_UNAVAILABLE",
          message: "No complete Unity WebGL build was found in the configured external folder.",
        }, method);
      }
      return;
    }

    if (
      !requestUrl.pathname.startsWith("/Build/")
      && !requestUrl.pathname.startsWith("/StreamingAssets/")
    ) {
      sendJson(response, 404, { error: "NOT_FOUND" }, method);
      return;
    }

    let fileHandle;
    try {
      const filePath = await resolveRequestFile(configuredRootPath, requestUrl.pathname);
      if (!filePath) {
        sendJson(response, 404, { error: "NOT_FOUND" }, method);
        return;
      }

      let markerFile;
      if (requestUrl.pathname.startsWith("/Build/")) {
        const marker = await readCompletionMarker(configuredRootPath);
        if (!marker.exists || ![1, 2].includes(marker.value?.version)) {
          sendJson(response, 503, { error: "BUILD_UNAVAILABLE" }, method);
          return;
        }
        if (requestUrl.searchParams.get("buildId") !== marker.value.buildId) {
          sendJson(response, 409, { error: "STALE_BUILD" }, method);
          return;
        }
        markerFile = marker.value.files?.find((entry) => entry.fileName === basename(filePath));
        if (!markerFile) {
          sendJson(response, 404, { error: "NOT_FOUND" }, method);
          return;
        }
      }

      const { contentEncoding, contentType } = getContentMetadata(filePath);
      fileHandle = await open(filePath, "r");
      const fileStats = await fileHandle.stat();
      if (
        markerFile
        && (markerFile.size !== fileStats.size || markerFile.mtimeMs !== fileStats.mtimeMs)
      ) {
        sendJson(response, 409, { error: "STALE_BUILD" }, method);
        return;
      }
      const compress = Boolean(markerFile)
        && !contentEncoding
        && acceptsGzip(request.headers["accept-encoding"]);
      const responseEncoding = compress ? "gzip" : contentEncoding;
      response.statusCode = 200;
      setCommonHeaders(response);
      response.setHeader("Content-Type", contentType);
      if (responseEncoding) response.setHeader("Content-Encoding", responseEncoding);
      if (markerFile) {
        // Revalidate cached bytes after all build guards, including during rebuilds.
        const etag = `W/"${markerFile.hash}-${responseEncoding ?? "identity"}"`;
        response.setHeader("Cache-Control", "private, no-cache");
        response.setHeader("Vary", "Accept-Encoding");
        response.setHeader("ETag", etag);
        if (matchesEtag(request.headers["if-none-match"], etag)) {
          response.statusCode = 304;
          response.end();
          return;
        }
      }
      if (!compress) response.setHeader("Content-Length", fileStats.size);
      if (method === "HEAD") {
        response.end();
      } else {
        const file = fileHandle.createReadStream();
        fileHandle = undefined; // The stream owns and closes the file descriptor.
        if (compress) {
          await pipeline(file, createGzip({ level: 1 }), response);
        } else {
          await pipeline(file, response);
        }
      }
    } catch {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.removeHeader("Content-Encoding");
      response.removeHeader("ETag");
      sendJson(response, 404, { error: "NOT_FOUND" }, method);
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  });
};

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const rootPath = resolve(process.env.THREE_BOSSES_WEBGL_DIR || defaultRoot());
  const server = createThreeBossesWebGlServer({ rootPath });
  server.listen(DEFAULT_PORT, LOOPBACK_HOST, () => {
    console.log(`Three Bosses WebGL assets: http://${LOOPBACK_HOST}:${DEFAULT_PORT}`);
    console.log(`External build directory: ${rootPath}`);
  });
}
