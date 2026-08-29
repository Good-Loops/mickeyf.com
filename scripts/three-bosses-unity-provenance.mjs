import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

export const REQUIRED_UNITY_EDITOR_VERSION = "6000.3.8f1";
export const UNITY_PROVENANCE_KEYS = Object.freeze([
  "sourceCommit",
  "unityEditorVersion",
  "unitySourceDigest",
  "unitySourceFileCount",
]);

const executeFile = promisify(execFile);
const unityProjectPath = "unity/three-bosses";
const unitySourcePathspecs = [
  `${unityProjectPath}/Assets`,
  `${unityProjectPath}/Packages`,
  `${unityProjectPath}/ProjectSettings`,
];
const commitPattern = /^[a-f0-9]{40,64}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const comparePaths = (left, right) => left < right ? -1 : left > right ? 1 : 0;

const isContainedPath = (basePath, targetPath) => {
  const fromBase = relative(basePath, targetPath);
  return fromBase === "" || (!fromBase.startsWith(`..${sep}`) && !isAbsolute(fromBase));
};

export const runGit = async (repositoryRoot, args) => {
  try {
    const { stdout } = await executeFile("git", ["-C", repositoryRoot, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const detail = typeof error.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(
      `Git ${args[0]} failed${detail ? `: ${detail}` : "."}`,
      { cause: error },
    );
  }
};

const parseGitTree = (rawTree) => rawTree
  .split("\0")
  .filter(Boolean)
  .map((record) => {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("Git returned malformed Unity source metadata.");

    const metadata = record.slice(0, separator).split(" ");
    if (metadata.length !== 3) throw new Error("Git returned malformed Unity source metadata.");
    const [mode, type, objectId] = metadata;
    const path = record.slice(separator + 1);
    if (type !== "blob" || mode === "120000") {
      throw new Error(`Unity source contains a non-regular tracked entry: ${path}.`);
    }
    return { mode, objectId, path };
  })
  .sort((left, right) => comparePaths(left.path, right.path));

export const digestUnitySourceEntries = (entries) => {
  const digest = createHash("sha256");
  digest.update("mickeyf-three-bosses-unity-source-v1\0", "utf8");
  for (const entry of [...entries].sort((left, right) => comparePaths(left.path, right.path))) {
    digest.update(entry.mode, "utf8");
    digest.update("\0", "utf8");
    digest.update(entry.path, "utf8");
    digest.update("\0", "utf8");
    digest.update(entry.objectId, "utf8");
    digest.update("\0", "utf8");
  }
  return digest.digest("hex");
};

export const readUnitySourceTree = async (repositoryRoot, ref = "HEAD") => {
  const tree = parseGitTree(await runGit(repositoryRoot, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    ref,
    "--",
    ...unitySourcePathspecs,
  ]));
  if (tree.length === 0) throw new Error(`No committed Unity source files were found at ${ref}.`);
  return tree;
};

const assertCleanUnitySource = async (repositoryRoot) => {
  const flaggedIndexEntries = (await runGit(repositoryRoot, [
    "ls-files",
    "-v",
    "-z",
    "--",
    ...unitySourcePathspecs,
  ]))
    .split("\0")
    .filter(Boolean)
    .filter((record) => record[0] !== "H");
  if (flaggedIndexEntries.length > 0) {
    const [firstEntry] = flaggedIndexEntries;
    throw new Error(
      `Unity source contains a non-normal Git index flag: ${firstEntry[0]} ${firstEntry.slice(2)}.`,
    );
  }

  const dirty = await runGit(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    unityProjectPath,
  ]);
  if (dirty.length > 0) {
    throw new Error(
      "Unity source must be clean and committed before a release build, package, or validation.",
    );
  }
  const ignoredSource = await runGit(repositoryRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
    "--",
    ...unitySourcePathspecs,
  ]);
  if (ignoredSource.length > 0) {
    throw new Error(
      "Unity source roots contain ignored files; release provenance would not cover imported content.",
    );
  }
};

const readUnityEditorVersion = async (repositoryRoot) => {
  const projectVersion = await readFile(join(
    repositoryRoot,
    "unity",
    "three-bosses",
    "ProjectSettings",
    "ProjectVersion.txt",
  ), "utf8");
  const unityEditorVersion = /^m_EditorVersion:\s*(\S+)\s*$/mu.exec(projectVersion)?.[1];
  if (unityEditorVersion !== REQUIRED_UNITY_EDITOR_VERSION) {
    throw new Error(
      `Three Bosses must use Unity ${REQUIRED_UNITY_EDITOR_VERSION}; found ${unityEditorVersion ?? "none"}.`,
    );
  }
  return unityEditorVersion;
};

export const readCurrentUnityTreeProvenance = async ({ repositoryRoot }) => {
  await assertCleanUnitySource(repositoryRoot);
  const sourceCommit = (await runGit(repositoryRoot, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ])).trim();
  if (!commitPattern.test(sourceCommit)) {
    throw new Error("Git returned an invalid HEAD commit for the Unity provenance.");
  }

  const tree = await readUnitySourceTree(repositoryRoot);
  const projectRoot = resolve(repositoryRoot, unityProjectPath);
  const projectStats = await lstat(projectRoot);
  if (projectStats.isSymbolicLink() || !projectStats.isDirectory()) {
    throw new Error("The Three Bosses Unity project root must be a real directory.");
  }
  const canonicalProjectRoot = await realpath(projectRoot);
  const verifiedDirectories = new Set([projectRoot]);
  const canonicalSourceRoots = new Map();
  for (const entry of tree) {
    const absolutePath = join(repositoryRoot, ...entry.path.split("/"));
    const fromProject = relative(projectRoot, absolutePath);
    if (!fromProject || !isContainedPath(projectRoot, absolutePath)) {
      throw new Error(`Unity source path escaped its project root: ${entry.path}.`);
    }
    const segments = fromProject.split(sep);
    let directoryPath = projectRoot;
    for (const segment of segments.slice(0, -1)) {
      directoryPath = join(directoryPath, segment);
      if (verifiedDirectories.has(directoryPath)) continue;
      const directoryStats = await lstat(directoryPath);
      if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
        throw new Error(`Unity source contains a linked or invalid ancestor: ${entry.path}.`);
      }
      const canonicalDirectory = await realpath(directoryPath);
      if (!isContainedPath(canonicalProjectRoot, canonicalDirectory)) {
        throw new Error(`Unity source ancestor resolves outside the project: ${entry.path}.`);
      }
      verifiedDirectories.add(directoryPath);
      if (directoryPath === join(projectRoot, segments[0])) {
        canonicalSourceRoots.set(segments[0], canonicalDirectory);
      }
    }
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Unity source contains a non-regular working-tree entry: ${entry.path}.`);
    }
    const canonicalPath = await realpath(absolutePath);
    const canonicalSourceRoot = canonicalSourceRoots.get(segments[0]);
    if (!canonicalSourceRoot
        || !isContainedPath(canonicalProjectRoot, canonicalPath)
        || !isContainedPath(canonicalSourceRoot, canonicalPath)) {
      throw new Error(`Unity source resolves outside its canonical source root: ${entry.path}.`);
    }
  }

  return Object.freeze({
    sourceCommit,
    unityEditorVersion: await readUnityEditorVersion(repositoryRoot),
    unitySourceDigest: digestUnitySourceEntries(tree),
    unitySourceFileCount: tree.length,
  });
};

export const normalizeUnityBuildProvenance = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Unity build provenance must be an object.");
  }
  const keys = Object.keys(value).sort(comparePaths);
  const expectedKeys = [...UNITY_PROVENANCE_KEYS].sort(comparePaths);
  if (keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Unity build provenance does not match the exact schema.");
  }
  if (!commitPattern.test(value.sourceCommit)
      || !hashPattern.test(value.unitySourceDigest)
      || !Number.isSafeInteger(value.unitySourceFileCount)
      || value.unitySourceFileCount <= 0
      || value.unityEditorVersion !== REQUIRED_UNITY_EDITOR_VERSION) {
    throw new Error("Unity build provenance contains an invalid value.");
  }
  return Object.freeze({
    sourceCommit: value.sourceCommit,
    unityEditorVersion: value.unityEditorVersion,
    unitySourceDigest: value.unitySourceDigest,
    unitySourceFileCount: value.unitySourceFileCount,
  });
};

export const sameUnityBuildProvenance = (left, right) => {
  try {
    const normalizedLeft = normalizeUnityBuildProvenance(left);
    const normalizedRight = normalizeUnityBuildProvenance(right);
    return UNITY_PROVENANCE_KEYS.every((key) => normalizedLeft[key] === normalizedRight[key]);
  } catch {
    return false;
  }
};

export const sameUnityTreeProvenance = (left, right) => {
  try {
    const normalizedLeft = normalizeUnityBuildProvenance(left);
    const normalizedRight = normalizeUnityBuildProvenance(right);
    return normalizedLeft.unityEditorVersion === normalizedRight.unityEditorVersion
      && normalizedLeft.unitySourceDigest === normalizedRight.unitySourceDigest
      && normalizedLeft.unitySourceFileCount === normalizedRight.unitySourceFileCount;
  } catch {
    return false;
  }
};

export const readCommittedUnityProvenance = async ({ repositoryRoot }) => {
  const currentTree = await readCurrentUnityTreeProvenance({ repositoryRoot });
  return Object.freeze({
    sourceCommit: currentTree.sourceCommit,
    unityEditorVersion: currentTree.unityEditorVersion,
    unitySourceDigest: currentTree.unitySourceDigest,
    unitySourceFileCount: currentTree.unitySourceFileCount,
  });
};

export const markerProvenanceFor = (provenance) => normalizeUnityBuildProvenance({
  sourceCommit: provenance.sourceCommit,
  unityEditorVersion: provenance.unityEditorVersion,
  unitySourceDigest: provenance.unitySourceDigest,
  unitySourceFileCount: provenance.unitySourceFileCount,
});
