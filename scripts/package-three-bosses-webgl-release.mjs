import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import {
  BUILD_COMPLETION_MARKER,
  readBuildManifest,
} from "./serve-three-bosses-webgl.mjs";
import {
  digestUnitySourceEntries,
  markerProvenanceFor,
  normalizeUnityBuildProvenance,
  readCommittedUnityProvenance,
  readCurrentUnityTreeProvenance,
  REQUIRED_UNITY_EDITOR_VERSION,
  sameUnityTreeProvenance,
} from "./three-bosses-unity-provenance.mjs";

export { digestUnitySourceEntries, REQUIRED_UNITY_EDITOR_VERSION };

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = resolve(scriptDirectory, "..");
const allowedExternalRootEntries = new Map([
  [BUILD_COMPLETION_MARKER, "file"],
  ["Build", "directory"],
  ["StreamingAssets", "directory"],
  ["TemplateData", "directory"],
  ["index.html", "file"],
]);
const debugFilePattern = /[.](?:debug|dsym|map|mdb|pdb|symbols)(?:[.]|$)/iu;
const unsafeUrlPathCharacterPattern = /[%?#\u0000-\u001f\u007f]/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40,64}$/u;
const comparePaths = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const manifestKeys = [
  "assets", "buildId", "certifiedBuildId", "codeUrl",
  "companyName", "dataUrl", "frameworkUrl", "loaderUrl", "productName",
  "productVersion", "sourceCommit", "streamingAssetsUrl", "unityEditorVersion",
  "unitySourceDigest", "unitySourceFileCount", "version",
].sort(comparePaths);
const manifestAssetKeys = ["path", "sha256", "size"].sort(comparePaths);
const windowsRenameRetryDelaysMs = [25, 100, 250, 500];
const maxReleaseAssetCount = 2_000;
const maxReleaseBytes = 64 * 1024 * 1024;
const maxUnityDataBytes = 32 * 1024 * 1024;
const maxOtherAssetBytes = 16 * 1024 * 1024;

const defaultExternalBuildRoot = () => {
  if (process.env.THREE_BOSSES_WEBGL_DIR) return resolve(process.env.THREE_BOSSES_WEBGL_DIR);
  if (process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "mickeyf.com", "three-bosses-webgl");
  }
  throw new Error(
    "LOCALAPPDATA is unavailable; set THREE_BOSSES_WEBGL_DIR to the certified WebGL build.",
  );
};

const fileHash = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const pathKind = (entry) => {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
};

const pathExists = async (path) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

const isContainedPath = (basePath, targetPath) => {
  const fromBase = relative(basePath, targetPath);
  return fromBase === "" || (!fromBase.startsWith(`..${sep}`) && !isAbsolute(fromBase));
};

const ensureRealDirectoryChain = async ({ basePath, create = false, label, targetPath }) => {
  const resolvedBase = resolve(basePath);
  const resolvedTarget = resolve(targetPath);
  if (!isContainedPath(resolvedBase, resolvedTarget)) {
    throw new Error(`${label} must stay inside its expected parent directory.`);
  }
  const baseStats = await pathExists(resolvedBase);
  if (!baseStats || baseStats.isSymbolicLink() || !baseStats.isDirectory()) {
    throw new Error(`${label} parent must be a real directory.`);
  }
  const canonicalBase = await realpath(resolvedBase);
  let cursor = resolvedBase;
  const pathFromBase = relative(resolvedBase, resolvedTarget);
  for (const segment of pathFromBase ? pathFromBase.split(sep) : []) {
    cursor = join(cursor, segment);
    let stats = await pathExists(cursor);
    if (!stats && create) {
      await mkdir(cursor);
      stats = await lstat(cursor);
    }
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${label} contains a missing, linked, or non-directory ancestor.`);
    }
  }
  const canonicalTarget = await realpath(resolvedTarget);
  if (!isContainedPath(canonicalBase, canonicalTarget)) {
    throw new Error(`${label} resolves outside its expected parent directory.`);
  }
  return canonicalTarget;
};

const assertSameFilesystem = async (leftPath, rightPath, label) => {
  const [left, right] = await Promise.all([stat(leftPath), stat(rightPath)]);
  if (left.dev !== right.dev) {
    const error = new Error(`${label} must use one filesystem for atomic publication.`);
    error.code = "EXDEV";
    throw error;
  }
};

const assertSafeRelativeAssetPath = (relativePath, label = "Release asset") => {
  if (typeof relativePath !== "string"
      || !relativePath
      || relativePath.includes("\\")
      || unsafeUrlPathCharacterPattern.test(relativePath)
      || posix.isAbsolute(relativePath)
      || posix.normalize(relativePath) !== relativePath
      || relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} has an unsafe URL path: ${relativePath}.`);
  }
};

const rejectDebugFile = (relativePath) => {
  if (debugFilePattern.test(relativePath)) {
    throw new Error(`Release input contains a debug artifact: ${relativePath}.`);
  }
};

const collectFiles = async (rootPath, { label, rejectDebug = true } = {}) => {
  const rootStats = await pathExists(rootPath);
  if (!rootStats) return [];
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`${label ?? rootPath} must be a real directory.`);
  }
  const files = [];
  const visit = async (directoryPath, relativeDirectory = "") => {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? posix.join(relativeDirectory, entry.name)
        : entry.name;
      const absolutePath = join(directoryPath, entry.name);
      const kind = pathKind(entry);
      if (kind === "symlink") {
        throw new Error(`${label ?? rootPath} contains a symbolic link: ${relativePath}.`);
      }
      if (kind === "directory") {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (kind !== "file") {
        throw new Error(`${label ?? rootPath} contains a non-regular entry: ${relativePath}.`);
      }
      assertSafeRelativeAssetPath(relativePath, label ?? "Release asset");
      if (rejectDebug) rejectDebugFile(relativePath);
      files.push({ absolutePath, relativePath });
    }
  };
  await visit(rootPath);
  return files.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
};

export const assertWebGlReleaseResourceCaps = (assets) => {
  if (!Array.isArray(assets) || assets.length > maxReleaseAssetCount) {
    throw new Error(`WebGL release exceeds the ${maxReleaseAssetCount}-file deploy cap.`);
  }
  let totalSize = 0;
  for (const asset of assets) {
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error("WebGL release assets must have a positive safe-integer size.");
    }
    const perFileLimit = asset.relativePath?.endsWith(".data.br")
      ? maxUnityDataBytes
      : maxOtherAssetBytes;
    if (asset.size > perFileLimit) {
      throw new Error("WebGL release asset exceeds its deploy per-file size cap.");
    }
    totalSize += asset.size;
    if (!Number.isSafeInteger(totalSize) || totalSize > maxReleaseBytes) {
      throw new Error("WebGL release exceeds the 64 MiB expanded deploy cap.");
    }
  }
};

const inspectExternalRoot = async (externalBuildRoot) => {
  const rootStats = await lstat(externalBuildRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("The certified external WebGL build must be a real directory.");
  }
  const rootEntries = await readdir(externalBuildRoot, { withFileTypes: true });
  const names = new Set(rootEntries.map((entry) => entry.name));
  if (!names.has("Build") || !names.has(BUILD_COMPLETION_MARKER)) {
    throw new Error("The external WebGL build lacks Build or its completion marker.");
  }
  for (const entry of rootEntries) {
    const expectedKind = allowedExternalRootEntries.get(entry.name);
    const actualKind = pathKind(entry);
    if (!expectedKind) {
      throw new Error(`Unexpected file in the external WebGL build: ${entry.name}.`);
    }
    if (actualKind !== expectedKind) {
      throw new Error(`External WebGL entry ${entry.name} must be a real ${expectedKind}.`);
    }
  }
  if (names.has("TemplateData")) {
    await collectFiles(join(externalBuildRoot, "TemplateData"), { label: "Unity TemplateData" });
  }

  const localManifest = await readBuildManifest(externalBuildRoot);
  if (!hashPattern.test(localManifest.buildId)) {
    throw new Error("The certified external WebGL build ID is invalid.");
  }
  const markerPath = join(externalBuildRoot, BUILD_COMPLETION_MARKER);
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    throw new Error("The external WebGL completion marker is invalid JSON.", { cause: error });
  }
  if (marker.version !== 2 || marker.buildId !== localManifest.buildId) {
    throw new Error("Packaging requires a provenance-bound release completion marker.");
  }
  const markerProvenance = normalizeUnityBuildProvenance(marker.provenance);

  const buildUrlFields = ["loaderUrl", "dataUrl", "frameworkUrl", "codeUrl"];
  const exactPatterns = [
    /[.]loader[.]js$/u,
    /[.]data[.]br$/u,
    /[.]framework[.]js[.]br$/u,
    /[.]wasm[.]br$/u,
  ];
  const expectedBuildFiles = buildUrlFields.map((field, index) => {
    const value = localManifest[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`The certified WebGL manifest is missing ${field}.`);
    }
    const fileName = decodeURIComponent(basename(new URL(value, "https://release.invalid/").pathname));
    assertSafeRelativeAssetPath(fileName, `Certified WebGL ${field}`);
    if (!exactPatterns[index].test(fileName)) {
      throw new Error("Release WebGL assets must use the exact Brotli production file set.");
    }
    return fileName;
  });
  if (new Set(expectedBuildFiles).size !== expectedBuildFiles.length) {
    throw new Error("The certified WebGL manifest contains duplicate build assets.");
  }

  const buildFiles = await collectFiles(join(externalBuildRoot, "Build"), {
    label: "Unity Build",
  });
  if (buildFiles.some((entry) => entry.relativePath.includes("/"))) {
    throw new Error("Unity Build contains an unexpected nested file.");
  }
  const actualBuildFiles = buildFiles.map((entry) => entry.relativePath);
  const expectedSorted = [...expectedBuildFiles].sort(comparePaths);
  if (actualBuildFiles.length !== expectedSorted.length
      || actualBuildFiles.some((name, index) => name !== expectedSorted[index])) {
    throw new Error(
      `Unity Build must contain only its four certified runtime files; found ${actualBuildFiles.join(", ")}.`,
    );
  }
  const markerFiles = new Map((marker.files ?? []).map((entry) => [entry.fileName, entry]));
  if (markerFiles.size !== expectedBuildFiles.length
      || !expectedBuildFiles.every((fileName) => markerFiles.has(fileName))) {
    throw new Error("The external WebGL completion marker has an invalid file set.");
  }

  const buildAssets = [];
  for (const entry of buildFiles) {
    const stats = await lstat(entry.absolutePath);
    const sha256 = await fileHash(entry.absolutePath);
    const certifiedFile = markerFiles.get(entry.relativePath);
    if (!certifiedFile
        || certifiedFile.hash !== sha256
        || certifiedFile.size !== stats.size
        || certifiedFile.mtimeMs !== stats.mtimeMs) {
      throw new Error(`Certified WebGL file no longer matches its marker: ${entry.relativePath}.`);
    }
    buildAssets.push({
      absolutePath: entry.absolutePath,
      relativePath: posix.join("Build", entry.relativePath),
      sha256,
      size: stats.size,
    });
  }
  const streamingFiles = await collectFiles(join(externalBuildRoot, "StreamingAssets"), {
    label: "Unity StreamingAssets",
  });
  if (streamingFiles.length > 0) {
    throw new Error(
      "StreamingAssets cannot be packaged until the completion marker recursively certifies them.",
    );
  }
  const assets = buildAssets.sort(
    (left, right) => comparePaths(left.relativePath, right.relativePath),
  );
  assertWebGlReleaseResourceCaps(assets);
  return {
    assets,
    certifiedBuildId: marker.buildId,
    expectedBuildFiles: Object.fromEntries(
      buildUrlFields.map((field, index) => [field, expectedBuildFiles[index]]),
    ),
    localManifest,
    markerProvenance,
  };
};

const releaseIdFor = (assets) => {
  const digest = createHash("sha256");
  digest.update("mickeyf-three-bosses-webgl-release-v1\0", "utf8");
  for (const asset of assets) {
    digest.update(asset.relativePath, "utf8");
    digest.update("\0", "utf8");
    digest.update(String(asset.size), "utf8");
    digest.update("\0", "utf8");
    digest.update(asset.sha256, "utf8");
    digest.update("\0", "utf8");
  }
  return digest.digest("hex");
};

const releaseTreeMetadata = async (releasePath) => {
  const files = await collectFiles(releasePath, { label: "Packaged WebGL release" });
  const metadata = [];
  for (const entry of files) {
    const stats = await lstat(entry.absolutePath);
    metadata.push({
      relativePath: entry.relativePath,
      sha256: await fileHash(entry.absolutePath),
      size: stats.size,
    });
  }
  return metadata;
};

const verifyReleaseTree = async (releasePath, expectedAssets) => {
  const actual = await releaseTreeMetadata(releasePath);
  if (actual.length !== expectedAssets.length) {
    throw new Error("Packaged WebGL release contains an unexpected file set.");
  }
  for (let index = 0; index < actual.length; index += 1) {
    const expected = expectedAssets[index];
    const found = actual[index];
    if (found.relativePath !== expected.relativePath
        || found.sha256 !== expected.sha256
        || found.size !== expected.size) {
      throw new Error(`Packaged WebGL release verification failed at ${found.relativePath}.`);
    }
  }
};

export const publishReleaseDirectoryAtomically = async ({
  stagingPath,
  releasePath,
  expectedAssets,
  renameDirectory = rename,
  waitForRetry = wait,
}) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameDirectory(stagingPath, releasePath);
      return;
    } catch (error) {
      const destination = await pathExists(releasePath);
      if (destination) {
        if (destination.isSymbolicLink() || !destination.isDirectory()) {
          throw new Error("The published WebGL release path must be a real directory.");
        }
        await verifyReleaseTree(releasePath, expectedAssets);
        return;
      }
      const retryDelayMs = windowsRenameRetryDelaysMs[attempt];
      const transient = error.code === "EPERM" || error.code === "EBUSY";
      if (!transient || retryDelayMs === undefined) throw error;
      await waitForRetry(retryDelayMs);
    }
  }
};

export const publishManifestAtomically = async ({
  stagingPath,
  manifestPath,
  renameFile = rename,
  waitForRetry = wait,
}) => {
  const existing = await pathExists(manifestPath);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error("The stable WebGL manifest path must be a regular file.");
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(stagingPath, manifestPath);
      return;
    } catch (error) {
      const retryDelayMs = windowsRenameRetryDelaysMs[attempt];
      const transient = error.code === "EPERM" || error.code === "EBUSY";
      if (!transient || retryDelayMs === undefined) throw error;
      await waitForRetry(retryDelayMs);
    }
  }
};

export const removeReleaseDirectoryWithRetry = async ({
  releasePath,
  removeDirectory = (path) => rm(path, { recursive: true }),
  waitForRetry = wait,
}) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await removeDirectory(releasePath);
      return;
    } catch (error) {
      const retryDelayMs = windowsRenameRetryDelaysMs[attempt];
      const transient = error.code === "EPERM" || error.code === "EBUSY";
      if (!transient || retryDelayMs === undefined) throw error;
      await waitForRetry(retryDelayMs);
    }
  }
};

export const acquireWebGlPackageLock = async ({ stagingRoot }) => {
  const lockPath = join(stagingRoot, ".package.lock");
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("Another Three Bosses WebGL packaging transaction is active.", {
        cause: error,
      });
    }
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    await removeReleaseDirectoryWithRetry({ releasePath: lockPath });
    released = true;
  };
};

const copyReleaseAtomically = async ({ assets, publicRoot, releaseId, stagingRoot }) => {
  const releasesRoot = join(publicRoot, "releases");
  const releasePath = join(releasesRoot, releaseId);
  const existing = await pathExists(releasePath);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Existing release path is not a real directory: ${releaseId}.`);
    }
    await verifyReleaseTree(releasePath, assets);
    return { created: false, releasePath };
  }
  const stagingPath = join(stagingRoot, `.${releaseId}.${randomUUID()}.tmp`);
  try {
    await mkdir(stagingPath);
    for (const asset of assets) {
      const destination = join(stagingPath, ...asset.relativePath.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(asset.absolutePath, destination);
    }
    await verifyReleaseTree(stagingPath, assets);
    await publishReleaseDirectoryAtomically({
      expectedAssets: assets,
      releasePath,
      stagingPath,
    });
    return { created: true, releasePath };
  } finally {
    await rm(stagingPath, { force: true, recursive: true });
  }
};

const releaseAssetUrl = (releaseId, relativePath) =>
  posix.join("releases", releaseId, relativePath);

const assertExactObjectKeys = (value, expectedKeys, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actualKeys = Object.keys(value).sort(comparePaths);
  if (actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`${label} does not match the exact release schema.`);
  }
};

const requireManifestString = (manifest, field, pattern) => {
  const value = manifest[field];
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new Error(`Packaged WebGL manifest has an invalid ${field}.`);
  }
  return value;
};

const parsePackagedManifest = (manifest) => {
  assertExactObjectKeys(manifest, manifestKeys, "Packaged WebGL manifest");
  if (manifest.version !== 2) throw new Error("Packaged WebGL manifest has an unsupported version.");
  const buildId = requireManifestString(manifest, "buildId", hashPattern);
  requireManifestString(manifest, "certifiedBuildId", hashPattern);
  requireManifestString(manifest, "sourceCommit", commitPattern);
  requireManifestString(manifest, "unitySourceDigest", hashPattern);
  if (manifest.unityEditorVersion !== REQUIRED_UNITY_EDITOR_VERSION) {
    throw new Error("Packaged WebGL manifest has an invalid unityEditorVersion.");
  }
  requireManifestString(manifest, "companyName");
  requireManifestString(manifest, "productName");
  requireManifestString(manifest, "productVersion");
  if (!Number.isSafeInteger(manifest.unitySourceFileCount) || manifest.unitySourceFileCount <= 0) {
    throw new Error("Packaged WebGL manifest has an invalid unitySourceFileCount.");
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length < 4) {
    throw new Error("Packaged WebGL manifest must list its release assets.");
  }

  const releasePrefix = `releases/${buildId}/`;
  const seenPaths = new Set();
  const seenFoldedPaths = new Set();
  const assets = manifest.assets.map((asset, index) => {
    assertExactObjectKeys(asset, manifestAssetKeys, `Packaged WebGL asset ${index}`);
    if (typeof asset.path !== "string" || !asset.path.startsWith(releasePrefix)) {
      throw new Error(`Packaged WebGL asset ${index} has an invalid release path.`);
    }
    const relativePath = asset.path.slice(releasePrefix.length);
    assertSafeRelativeAssetPath(relativePath, `Packaged WebGL asset ${index}`);
    if (!relativePath.startsWith("Build/") && !relativePath.startsWith("StreamingAssets/")) {
      throw new Error(`Packaged WebGL asset ${index} is outside Build and StreamingAssets.`);
    }
    rejectDebugFile(relativePath);
    const foldedPath = relativePath.toLocaleLowerCase("en-US");
    if (seenPaths.has(relativePath) || seenFoldedPaths.has(foldedPath)) {
      throw new Error(`Packaged WebGL manifest contains a duplicate asset: ${relativePath}.`);
    }
    seenPaths.add(relativePath);
    seenFoldedPaths.add(foldedPath);
    if (typeof asset.sha256 !== "string" || !hashPattern.test(asset.sha256)) {
      throw new Error(`Packaged WebGL asset ${relativePath} has an invalid hash.`);
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`Packaged WebGL asset ${relativePath} has an invalid size.`);
    }
    return { relativePath, sha256: asset.sha256, size: asset.size };
  });
  const sortedPaths = assets.map((asset) => asset.relativePath).sort(comparePaths);
  if (assets.some((asset, index) => asset.relativePath !== sortedPaths[index])) {
    throw new Error("Packaged WebGL manifest assets must be sorted by path.");
  }
  assertWebGlReleaseResourceCaps(assets);
  if (releaseIdFor(assets) !== buildId) {
    throw new Error("Packaged WebGL release ID does not match its listed asset content.");
  }
  const selectRuntimeAsset = (field, pattern) => {
    const matches = assets.filter((asset) => pattern.test(asset.relativePath));
    if (matches.length !== 1) {
      throw new Error(`Packaged WebGL manifest must list exactly one ${field}.`);
    }
    if (manifest[field] !== releaseAssetUrl(buildId, matches[0].relativePath)) {
      throw new Error(`Packaged WebGL manifest ${field} does not match its listed asset.`);
    }
  };
  selectRuntimeAsset("loaderUrl", /^Build\/[^/]+[.]loader[.]js$/u);
  selectRuntimeAsset("dataUrl", /^Build\/[^/]+[.]data[.]br$/u);
  selectRuntimeAsset("frameworkUrl", /^Build\/[^/]+[.]framework[.]js[.]br$/u);
  selectRuntimeAsset("codeUrl", /^Build\/[^/]+[.]wasm[.]br$/u);
  if (assets.filter((asset) => asset.relativePath.startsWith("Build/")).length !== 4) {
    throw new Error("Packaged WebGL release contains unexpected Build assets.");
  }
  if (manifest.streamingAssetsUrl !== releaseAssetUrl(buildId, "StreamingAssets")) {
    throw new Error("Packaged WebGL manifest has an invalid streamingAssetsUrl.");
  }
  return { assets };
};

const readManifestFile = async (manifestPath, label) => {
  const manifestStats = await pathExists(manifestPath);
  if (!manifestStats || manifestStats.isSymbolicLink() || !manifestStats.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
};

const assertReleaseDirectorySet = async ({ allowStale, buildId, releasesRoot }) => {
  const entries = await readdir(releasesRoot, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory() || !hashPattern.test(entry.name)) {
      throw new Error(`Packaged WebGL releases contains an invalid entry: ${entry.name}.`);
    }
    const releasePath = join(releasesRoot, entry.name);
    const stats = await lstat(releasePath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Packaged WebGL release is not a real directory: ${entry.name}.`);
    }
    names.push(entry.name);
  }
  names.sort(comparePaths);
  if (!names.includes(buildId)) throw new Error("The packaged WebGL release directory is missing.");
  if (!allowStale && (names.length !== 1 || names[0] !== buildId)) {
    throw new Error("Packaged WebGL releases must retain exactly the current release.");
  }
  return names;
};

const validateReleaseAtManifest = async ({
  allowStaleReleaseDirs,
  manifestPath,
  publicRoot,
  repositoryRoot,
}) => {
  const manifest = await readManifestFile(manifestPath, "The packaged WebGL manifest");
  const { assets } = parsePackagedManifest(manifest);
  const currentTree = await readCurrentUnityTreeProvenance({ repositoryRoot });
  if (manifest.unityEditorVersion !== currentTree.unityEditorVersion
      || manifest.unitySourceDigest !== currentTree.unitySourceDigest
      || manifest.unitySourceFileCount !== currentTree.unitySourceFileCount) {
    throw new Error("Packaged WebGL provenance does not match the current committed Unity source.");
  }
  const releasesRoot = join(publicRoot, "releases");
  await ensureRealDirectoryChain({
    basePath: repositoryRoot,
    label: "Packaged WebGL releases",
    targetPath: releasesRoot,
  });
  await assertReleaseDirectorySet({
    allowStale: allowStaleReleaseDirs,
    buildId: manifest.buildId,
    releasesRoot,
  });
  const releasePath = join(releasesRoot, manifest.buildId);
  await ensureRealDirectoryChain({
    basePath: releasesRoot,
    label: "Packaged WebGL release",
    targetPath: releasePath,
  });
  await verifyReleaseTree(releasePath, assets);
  return { manifest, releasePath };
};

const removeStaleReleases = async ({ buildId, releasesRoot }) => {
  const names = await assertReleaseDirectorySet({ allowStale: true, buildId, releasesRoot });
  const canonicalRoot = await realpath(releasesRoot);
  for (const name of names) {
    if (name === buildId) continue;
    const stalePath = join(releasesRoot, name);
    const canonicalStale = await realpath(stalePath);
    if (!isContainedPath(canonicalRoot, canonicalStale) || canonicalStale === canonicalRoot) {
      throw new Error("A stale WebGL release resolved outside the releases directory.");
    }
    await removeReleaseDirectoryWithRetry({ releasePath: stalePath });
  }
};

export const packageThreeBossesWebGlRelease = async ({
  repositoryRoot = defaultRepositoryRoot,
  externalBuildRoot = defaultExternalBuildRoot(),
  publicRoot = join(repositoryRoot, "frontend", "public", "unity", "three-bosses"),
} = {}) => {
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const resolvedExternalBuildRoot = resolve(externalBuildRoot);
  const resolvedPublicRoot = resolve(publicRoot);
  const stagingRoot = join(
    resolvedRepositoryRoot,
    "node_modules",
    ".cache",
    "three-bosses-webgl-release",
  );
  const releasesRoot = join(resolvedPublicRoot, "releases");
  await ensureRealDirectoryChain({
    basePath: resolvedRepositoryRoot,
    create: true,
    label: "Packaged WebGL releases",
    targetPath: releasesRoot,
  });
  await ensureRealDirectoryChain({
    basePath: resolvedRepositoryRoot,
    create: true,
    label: "WebGL release staging cache",
    targetPath: stagingRoot,
  });
  await assertSameFilesystem(releasesRoot, stagingRoot, "WebGL release publication");
  const releasePackageLock = await acquireWebGlPackageLock({ stagingRoot });
  let packageResult;
  let primaryError;
  try {
    const provenance = await readCommittedUnityProvenance({ repositoryRoot: resolvedRepositoryRoot });
    const certifiedBuild = await inspectExternalRoot(resolvedExternalBuildRoot);
    if (!sameUnityTreeProvenance(
      certifiedBuild.markerProvenance,
      markerProvenanceFor(provenance),
    )) {
      throw new Error("The release build marker does not match the current committed Unity source.");
    }

    const buildId = releaseIdFor(certifiedBuild.assets);
    const publication = await copyReleaseAtomically({
      assets: certifiedBuild.assets,
      publicRoot: resolvedPublicRoot,
      releaseId: buildId,
      stagingRoot,
    });
    const { expectedBuildFiles, localManifest } = certifiedBuild;
    const manifest = {
    version: 2,
    buildId,
    certifiedBuildId: certifiedBuild.certifiedBuildId,
    sourceCommit: certifiedBuild.markerProvenance.sourceCommit,
    unitySourceDigest: certifiedBuild.markerProvenance.unitySourceDigest,
    unitySourceFileCount: certifiedBuild.markerProvenance.unitySourceFileCount,
    unityEditorVersion: certifiedBuild.markerProvenance.unityEditorVersion,
    loaderUrl: releaseAssetUrl(buildId, posix.join("Build", expectedBuildFiles.loaderUrl)),
    dataUrl: releaseAssetUrl(buildId, posix.join("Build", expectedBuildFiles.dataUrl)),
    frameworkUrl: releaseAssetUrl(buildId, posix.join("Build", expectedBuildFiles.frameworkUrl)),
    codeUrl: releaseAssetUrl(buildId, posix.join("Build", expectedBuildFiles.codeUrl)),
    streamingAssetsUrl: releaseAssetUrl(buildId, "StreamingAssets"),
    companyName: localManifest.companyName,
    productName: localManifest.productName,
    productVersion: localManifest.productVersion,
    assets: certifiedBuild.assets.map((asset) => ({
      path: releaseAssetUrl(buildId, asset.relativePath),
      sha256: asset.sha256,
      size: asset.size,
    })),
    };

    const manifestPath = join(resolvedPublicRoot, "build-manifest.json");
    const candidatePath = join(stagingRoot, `.build-manifest.${randomUUID()}.tmp`);
    let switched = false;
    try {
      await writeFile(candidatePath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      });
      await validateReleaseAtManifest({
        allowStaleReleaseDirs: true,
        manifestPath: candidatePath,
        publicRoot: resolvedPublicRoot,
        repositoryRoot: resolvedRepositoryRoot,
      });
      await assertSameFilesystem(dirname(manifestPath), stagingRoot, "WebGL manifest publication");
      await publishManifestAtomically({ manifestPath, stagingPath: candidatePath });
      switched = true;
      await removeStaleReleases({ buildId, releasesRoot });
      await validatePackagedThreeBossesWebGlRelease({
        publicRoot: resolvedPublicRoot,
        repositoryRoot: resolvedRepositoryRoot,
      });
    } catch (error) {
      if (!switched && publication.created) {
        try {
          await removeReleaseDirectoryWithRetry({ releasePath: publication.releasePath });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `WebGL packaging failed and candidate release cleanup also failed: ${cleanupError.message}`,
          );
        }
      }
      throw error;
    } finally {
      await rm(candidatePath, { force: true });
    }
    packageResult = { buildId, manifest, manifestPath, releasePath: publication.releasePath };
  } catch (error) {
    primaryError = error;
  }

  try {
    await releasePackageLock();
  } catch (cleanupError) {
    if (primaryError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        `WebGL packaging failed and its package lock could not be released: ${cleanupError.message}`,
      );
    }
    throw cleanupError;
  }
  if (primaryError) throw primaryError;
  return packageResult;
};

export const validatePackagedThreeBossesWebGlRelease = async ({
  repositoryRoot = defaultRepositoryRoot,
  publicRoot = join(repositoryRoot, "frontend", "public", "unity", "three-bosses"),
} = {}) => {
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const resolvedPublicRoot = resolve(publicRoot);
  await ensureRealDirectoryChain({
    basePath: resolvedRepositoryRoot,
    label: "Packaged WebGL public directory",
    targetPath: resolvedPublicRoot,
  });
  const manifestPath = join(resolvedPublicRoot, "build-manifest.json");
  const { manifest, releasePath } = await validateReleaseAtManifest({
    allowStaleReleaseDirs: false,
    manifestPath,
    publicRoot: resolvedPublicRoot,
    repositoryRoot: resolvedRepositoryRoot,
  });
  return { buildId: manifest.buildId, manifest, manifestPath, releasePath };
};

export const runThreeBossesWebGlReleaseCli = async ({
  args = process.argv.slice(2),
  repositoryRoot = defaultRepositoryRoot,
  externalBuildRoot,
  publicRoot,
} = {}) => {
  if (args.length === 1 && args[0] === "--validate-packaged") {
    return {
      operation: "validate",
      ...await validatePackagedThreeBossesWebGlRelease({ repositoryRoot, publicRoot }),
    };
  }
  if (args.length !== 0) {
    throw new Error("Usage: package-three-bosses-webgl-release.mjs [--validate-packaged]");
  }
  return {
    operation: "package",
    ...await packageThreeBossesWebGlRelease({ repositoryRoot, externalBuildRoot, publicRoot }),
  };
};

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  runThreeBossesWebGlReleaseCli()
    .then(({ buildId, manifestPath, operation, releasePath }) => {
      console.log(`${operation === "validate" ? "Validated" : "Packaged"} Three Bosses WebGL release ${buildId}.`);
      console.log(`Release assets: ${releasePath}`);
      console.log(`Stable manifest: ${manifestPath}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
