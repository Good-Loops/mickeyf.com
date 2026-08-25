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
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
  const buildDirectory = join(rootPath, "Build");
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
  };
};

const completionMarkerPayload = async (buildDirectory, fileStats) => {
  const files = await Promise.all(fileStats.map(async ({ fileName, stats }) => ({
    fileName,
    hash: createHash("sha256").update(await readFile(join(buildDirectory, fileName))).digest("hex"),
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  })));
  const buildId = createHash("sha256")
    .update(files.map(({ fileName, hash, size }) => `${fileName}:${size}:${hash}`).join("|"))
    .digest("hex");
  return { buildId, files, version: 1 };
};

const completionMarkerMatches = (marker, expected) => {
  if (marker?.version !== 1 || !Array.isArray(marker.files)) return false;
  return marker.buildId === expected.buildId
    && expected.files.length === marker.files.length
    && expected.files.every((file, index) =>
    file.fileName === marker.files[index]?.fileName
    && file.hash === marker.files[index]?.hash
    && file.size === marker.files[index]?.size
    && file.mtimeMs === marker.files[index]?.mtimeMs);
};

const readCompletionMarker = async (rootPath) => {
  try {
    return {
      exists: true,
      value: JSON.parse(await readFile(join(rootPath, BUILD_COMPLETION_MARKER), "utf8")),
    };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, value: null };
    return { exists: true, value: null };
  }
};

export const invalidateBuildCompletionMarker = async (rootPath) => {
  await unlink(join(rootPath, BUILD_COMPLETION_MARKER)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
};

export const writeBuildCompletionMarker = async (rootPath) => {
  const { buildDirectory, fileStats } = await inspectBuildFiles(rootPath);
  const payload = await completionMarkerPayload(buildDirectory, fileStats);
  const markerPath = join(rootPath, BUILD_COMPLETION_MARKER);
  const temporaryPath = join(rootPath, `.${BUILD_COMPLETION_MARKER}.${randomUUID()}.tmp`);
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
  } = await inspectBuildFiles(rootPath);

  // The marker is removed before a guarded build and rewritten atomically only
  // after Unity and repository cleanup succeed. Requiring it keeps same-name
  // incremental builds fail-closed while payload files are being replaced.
  const marker = await readCompletionMarker(rootPath);
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

  const rootRealPath = await realpath(rootPath);
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
    contentEncoding = compressionExtension.slice(1);
    sourcePath = sourcePath.slice(0, -compressionExtension.length);
  }

  return {
    contentEncoding,
    contentType: contentTypes.get(extname(sourcePath).toLowerCase()) ?? "application/octet-stream",
  };
};

export const createThreeBossesWebGlServer = ({ rootPath = defaultRoot() } = {}) =>
  createHttpServer(async (request, response) => {
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
        sendJson(response, 200, await readBuildManifest(rootPath), method);
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

    try {
      const filePath = await resolveRequestFile(rootPath, requestUrl.pathname);
      if (!filePath) {
        sendJson(response, 404, { error: "NOT_FOUND" }, method);
        return;
      }

      let markerFile;
      if (requestUrl.pathname.startsWith("/Build/")) {
        const marker = await readCompletionMarker(rootPath);
        if (!marker.exists || marker.value?.version !== 1) {
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
      const fileHandle = await open(filePath, "r");
      const fileStats = await fileHandle.stat();
      if (
        markerFile
        && (markerFile.size !== fileStats.size || markerFile.mtimeMs !== fileStats.mtimeMs)
      ) {
        await fileHandle.close();
        sendJson(response, 409, { error: "STALE_BUILD" }, method);
        return;
      }
      response.statusCode = 200;
      setCommonHeaders(response);
      response.setHeader("Content-Type", contentType);
      response.setHeader("Content-Length", fileStats.size);
      if (contentEncoding) response.setHeader("Content-Encoding", contentEncoding);
      if (method === "HEAD") {
        await fileHandle.close();
        response.end();
      } else {
        const file = fileHandle.createReadStream();
        file.on("error", () => {
          if (!response.headersSent) {
            sendJson(response, 500, { error: "READ_FAILED" }, method);
          } else {
            response.destroy();
          }
        });
        response.on("close", () => file.destroy());
        file.pipe(response);
      }
    } catch {
      sendJson(response, 404, { error: "NOT_FOUND" }, method);
    }
  });

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
