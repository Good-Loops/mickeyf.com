import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  invalidateBuildCompletionMarker,
  writeBuildCompletionMarker,
} from "./serve-three-bosses-webgl.mjs";
import {
  markerProvenanceFor,
  readCommittedUnityProvenance,
  sameUnityBuildProvenance,
} from "./three-bosses-unity-provenance.mjs";

export const GUARDED_PROJECT_PATHS = Object.freeze([
  "ProjectSettings/ProjectSettings.asset",
  "Assets/Settings/UniversalRP.asset",
  "Assets/UniversalRenderPipelineGlobalSettings.asset",
]);

const ACTIVE_BUILD_STATUSES = new Set(["queued", "building"]);
const TERMINAL_BUILD_STATUS = "completed";
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export const PIPELINE_RUNTIME_DISABLED_WARNING =
  "Pipeline: No RuntimePipelineManager components found in build scenes. Pipeline will be disabled in Player builds.";

const PIPELINE_GLOBAL_LIGHT_LAYERS = Object.freeze([
  "Default",
  "Player",
  "Impact",
  "Boss",
  "Projectile",
]);

export const PIPELINE_GLOBAL_LIGHT_FALSE_POSITIVES = Object.freeze(
  PIPELINE_GLOBAL_LIGHT_LAYERS.flatMap((layer) => [
    `More than one global light on layer ${layer} for light blend style index 0`,
    `More than one global light on layer ${layer} for light blend style index 0`,
  ]),
);

const normalizeGitPath = (path) => path.split(sep).join("/");

export const getDefaultOutputPath = (environment = process.env) => {
  if (environment.THREE_BOSSES_WEBGL_DIR) return environment.THREE_BOSSES_WEBGL_DIR;

  const localAppData = environment.LOCALAPPDATA;
  if (localAppData) {
    return join(localAppData, "mickeyf.com", "three-bosses-webgl");
  }

  return join(tmpdir(), "mickeyf.com", "three-bosses-webgl");
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const diagnosticMessages = (entries) => (Array.isArray(entries) ? entries : [])
  .map((entry) => (typeof entry === "string" ? entry : entry?.message))
  .filter((message) => typeof message === "string" && message.length > 0);

const equalStringMultisets = (left, right) => {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
};

export const assessSuccessfulBuildDiagnostics = (buildStatus) => {
  const errors = diagnosticMessages(buildStatus?.errors);
  const reportedTotalErrors = Number.isInteger(buildStatus?.totalErrors)
    ? buildStatus.totalErrors
    : errors.length;
  if (reportedTotalErrors !== errors.length) {
    throw new Error(
      `Unity reported ${reportedTotalErrors} build error(s), but returned ${errors.length} diagnostic message(s).`,
    );
  }
  if (
    errors.length > 0
    && !equalStringMultisets(errors, PIPELINE_GLOBAL_LIGHT_FALSE_POSITIVES)
  ) {
    throw new Error(`Unity reported unexpected build errors: ${errors.join("; ")}`);
  }

  const warnings = diagnosticMessages(buildStatus?.warnings);
  const pipelineWarningIndex = warnings.indexOf(PIPELINE_RUNTIME_DISABLED_WARNING);
  const acceptedPipelineWarnings = pipelineWarningIndex >= 0 ? 1 : 0;
  const actionableWarningMessages = warnings.filter((_, index) => index !== pipelineWarningIndex);
  const reportedTotalWarnings = Number.isInteger(buildStatus?.totalWarnings)
    ? buildStatus.totalWarnings
    : warnings.length;

  return {
    acceptedGlobalLightErrors: errors.length,
    acceptedPipelineWarnings,
    actionableWarningMessages,
    actionableWarnings: Math.max(
      actionableWarningMessages.length,
      reportedTotalWarnings - acceptedPipelineWarnings,
    ),
  };
};

export const parseNulDelimitedBuffer = (buffer) => buffer
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

export const parseUnityEnvelope = (value, label = "Unity command") => {
  let envelope = value;
  if (typeof envelope === "string") {
    try {
      envelope = JSON.parse(envelope);
    } catch {
      throw new Error(`${label} returned malformed JSON.`);
    }
  }

  if (!envelope || typeof envelope !== "object") {
    throw new Error(`${label} returned an invalid response.`);
  }
  if (envelope.success !== true || envelope.data?.success === false) {
    throw new Error(`${label} failed.`);
  }

  let result = envelope.data?.result;
  if (typeof result === "string" && /^[\s]*[{[]/u.test(result)) {
    try {
      result = JSON.parse(result);
    } catch {
      throw new Error(`${label} returned malformed nested JSON.`);
    }
  }

  return result;
};

const runProcess = (executable, args, { cwd }) => new Promise((resolvePromise, reject) => {
  const child = spawn(executable, args, {
    cwd,
    shell: false,
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];

  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.on("error", reject);
  child.on("close", (code) => {
    const output = Buffer.concat(stdout).toString("utf8");
    if (code === 0) {
      resolvePromise(output);
      return;
    }

    const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
    const diagnostic = (errorOutput || output.trim()).slice(-4_000);
    reject(new Error(
      diagnostic
        ? `${executable} exited with code ${code}: ${diagnostic}`
        : `${executable} exited with code ${code}.`,
    ));
  });
});

export const invokeUnityCli = (args, { cwd }) => runProcess("unity", args, { cwd });

const invokeGit = (args, { cwd }) => runProcess("git", args, { cwd });

const commandResult = async (invokeUnity, args, label) =>
  parseUnityEnvelope(await invokeUnity(args), label);

const evalValue = async (invokeUnity, projectPath, code, label) => {
  const result = await commandResult(invokeUnity, [
    "command",
    "eval",
    "--project-path",
    projectPath,
    "--code",
    code,
    "--format",
    "json",
  ], label);

  if (!result || typeof result !== "object" || result.success !== true) {
    throw new Error(`${label} failed.`);
  }
  return result.result;
};

const guardedPathsLiteral = `new [] { ${GUARDED_PROJECT_PATHS
  .map((path) => JSON.stringify(path))
  .join(", ")} }`;

const guardedObjectStatusCode = `
var paths = ${guardedPathsLiteral};
return string.Join("\\n", paths.Select(path => {
    var assets = UnityEditor.AssetDatabase.LoadAllAssetsAtPath(path);
    var dirty = assets.Any(asset => asset != null && UnityEditor.EditorUtility.IsDirty(asset));
    return path + "=" + assets.Length + "," + dirty;
}));
`;

const guardedObjectReimportCode = `
var paths = ${guardedPathsLiteral};
UnityEditor.AssetDatabase.ReleaseCachedFileHandles();
var options = UnityEditor.ImportAssetOptions.ForceUpdate |
    UnityEditor.ImportAssetOptions.ForceSynchronousImport;
foreach (var path in paths)
    UnityEditor.AssetDatabase.ImportAsset(path, options);
return string.Join("\\n", paths.Select(path => {
    var assets = UnityEditor.AssetDatabase.LoadAllAssetsAtPath(path);
    var dirty = assets.Any(asset => asset != null && UnityEditor.EditorUtility.IsDirty(asset));
    return path + "=" + assets.Length + "," + dirty;
}));
`;

const releaseGuardedFileHandlesCode = `
UnityEditor.AssetDatabase.ReleaseCachedFileHandles();
return "released";
`;

const pendingBuildCode = `
var type = System.AppDomain.CurrentDomain.GetAssemblies()
    .SelectMany(assembly => {
        try { return assembly.GetTypes(); }
        catch (System.Reflection.ReflectionTypeLoadException error) {
            return error.Types.Where(candidate => candidate != null);
        }
    })
    .FirstOrDefault(candidate => candidate.FullName ==
        "Unity.Pipeline.Editor.Commands.Build.BuildCommand");
if (type == null) throw new System.InvalidOperationException("Build command type was not found.");
var field = type.GetField("s_Pending",
    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
if (field == null) throw new System.InvalidOperationException("Pending-build state was not found.");
return ((bool)field.GetValue(null)).ToString();
`;

const parseGuardedObjectStates = (value) => {
  const states = new Map();
  for (const line of String(value ?? "").split("\n").filter(Boolean)) {
    const separatorIndex = line.lastIndexOf("=");
    if (separatorIndex < 1) continue;
    const match = /^(?<count>[0-9]+),(?<dirty>True|False)$/u.exec(
      line.slice(separatorIndex + 1),
    );
    if (!match) continue;
    states.set(line.slice(0, separatorIndex), {
      count: Number.parseInt(match.groups.count, 10),
      dirty: match.groups.dirty === "True",
    });
  }
  return states;
};

export const assertGuardedObjectsClean = async (invokeUnity, projectPath) => {
  const value = await evalValue(
    invokeUnity,
    projectPath,
    guardedObjectStatusCode,
    "Guarded Unity object preflight",
  );
  const states = parseGuardedObjectStates(value);
  const unloadedPaths = GUARDED_PROJECT_PATHS.filter((path) =>
    !states.has(path) || states.get(path).count < 1);
  if (unloadedPaths.length > 0) {
    throw new Error(`Unity could not load guarded settings: ${unloadedPaths.join(", ")}.`);
  }

  const dirtyPaths = GUARDED_PROJECT_PATHS.filter((path) => states.get(path).dirty);

  if (dirtyPaths.length > 0) {
    throw new Error(
      `Refusing to build with unsaved guarded Unity settings: ${dirtyPaths.join(", ")}.`,
    );
  }
};

export const reimportGuardedObjects = async (invokeUnity, projectPath) => {
  const value = await evalValue(
    invokeUnity,
    projectPath,
    guardedObjectReimportCode,
    "Guarded Unity object reimport",
  );
  const states = parseGuardedObjectStates(value);
  const invalid = GUARDED_PROJECT_PATHS.filter((path) =>
    !states.has(path) || states.get(path).count < 1 || states.get(path).dirty);

  if (invalid.length > 0) {
    throw new Error(`Unity did not reload guarded settings cleanly: ${invalid.join(", ")}.`);
  }
};

const releaseGuardedFileHandles = async (invokeUnity, projectPath) => {
  const value = await evalValue(
    invokeUnity,
    projectPath,
    releaseGuardedFileHandlesCode,
    "Guarded Unity file-handle release",
  );
  if (value !== "released") throw new Error("Unity did not release cached asset file handles.");
};

const readPendingBuild = async (invokeUnity, projectPath) => {
  const value = await evalValue(
    invokeUnity,
    projectPath,
    pendingBuildCode,
    "Unity pending-build preflight",
  );
  if (value !== "True" && value !== "False") {
    throw new Error("Unity returned an invalid pending-build state.");
  }
  return value === "True";
};

export const readSnapshots = async (projectPath, paths = GUARDED_PROJECT_PATHS) =>
  Promise.all(paths.map(async (relativePath) => {
    const absolutePath = join(projectPath, relativePath);
    const [bytes, fileStats] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
    return {
      absolutePath,
      bytes,
      hash: sha256(bytes),
      mode: fileStats.mode,
      relativePath,
    };
  }));

const buffersEqual = (left, right) => left.byteLength === right.byteLength && left.equals(right);

const writeFileAtomic = async (targetPath, bytes, mode) => {
  const temporaryPath = join(
    dirname(targetPath),
    `.${targetPath.split(sep).at(-1)}.guard-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle;

  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(temporaryPath, targetPath);
        break;
      } catch (error) {
        if (!new Set(["EACCES", "EBUSY", "EPERM"]).has(error.code) || attempt >= 6) throw error;
        await sleepFor(50 * attempt);
      }
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
};

export const restoreSnapshots = async (snapshots) => {
  const failures = [];
  const restored = [];

  for (const snapshot of snapshots) {
    try {
      const current = await readFile(snapshot.absolutePath).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (current && buffersEqual(current, snapshot.bytes)) continue;

      await writeFileAtomic(snapshot.absolutePath, snapshot.bytes, snapshot.mode);
      restored.push(snapshot.relativePath);
    } catch (error) {
      failures.push(new Error(`Could not restore ${snapshot.relativePath}: ${error.message}`));
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "One or more guarded Unity settings files could not be restored.");
  }
  return restored;
};

export const verifySnapshots = async (snapshots) => {
  const mismatches = [];
  for (const snapshot of snapshots) {
    const current = await readFile(snapshot.absolutePath).catch(() => null);
    if (!current || !buffersEqual(current, snapshot.bytes)) mismatches.push(snapshot.relativePath);
  }
  if (mismatches.length > 0) {
    throw new Error(`Guarded Unity settings restoration mismatch: ${mismatches.join(", ")}.`);
  }
};

const describePath = async (absolutePath) => {
  try {
    const fileStats = await lstat(absolutePath);
    if (fileStats.isSymbolicLink()) {
      return { hash: sha256(Buffer.from(await readlink(absolutePath), "utf8")), kind: "symlink" };
    }
    if (!fileStats.isFile()) return { hash: "", kind: "other" };
    return { hash: sha256(await readFile(absolutePath)), kind: "file" };
  } catch (error) {
    if (error.code === "ENOENT") return { hash: "", kind: "missing" };
    throw error;
  }
};

export const captureUnitySourceState = async ({ repoRoot, projectPathspec }) => {
  const [trackedOutput, untrackedOutput] = await Promise.all([
    invokeGit(["ls-files", "-z", "--", projectPathspec], { cwd: repoRoot }),
    invokeGit([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      projectPathspec,
    ], { cwd: repoRoot }),
  ]);
  const paths = new Set([
    ...parseNulDelimitedBuffer(Buffer.from(trackedOutput, "utf8")),
    ...parseNulDelimitedBuffer(Buffer.from(untrackedOutput, "utf8")),
  ]);
  const entries = await Promise.all([...paths].sort().map(async (path) => [
    path,
    await describePath(join(repoRoot, path)),
  ]));
  return new Map(entries);
};

export const diffUnitySourceStates = (before, after) => {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((path) => {
      const left = before.get(path) ?? { hash: "", kind: "absent" };
      const right = after.get(path) ?? { hash: "", kind: "absent" };
      return left.kind !== right.kind || left.hash !== right.hash;
    })
    .sort();
};

const captureGuardedIndex = async ({ repoRoot, guardedRepoPaths }) => sha256(Buffer.from(
  await invokeGit(["ls-files", "--stage", "-z", "--", ...guardedRepoPaths], { cwd: repoRoot }),
  "utf8",
));

const acquireBuildLock = async (projectPath) => {
  const lockPath = join(projectPath, "Library", "mickeyf-webgl-build.lock");
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Another guarded WebGL build may be active (${lockPath}).`);
    }
    throw error;
  }
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, "utf8");
  await handle.close();

  return async () => {
    try {
      const value = JSON.parse(await readFile(lockPath, "utf8"));
      if (value.token === token) await unlink(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
};

const sleepFor = (milliseconds) => new Promise((resolvePromise) => {
  setTimeout(resolvePromise, milliseconds);
});

const canonicalizePotentialPath = async (path) => {
  const missingSegments = [];
  let cursor = resolve(path);

  while (true) {
    try {
      return join(await realpath(cursor), ...missingSegments.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(cursor.slice(parent.length).replace(/^[\\/]+/u, ""));
      cursor = parent;
    }
  }
};

const isAtOrInside = (parentPath, candidatePath) => {
  const fromParent = relative(parentPath, candidatePath);
  return !fromParent || (!fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent));
};

const readBuildStatus = (invokeUnity, projectPath) => commandResult(invokeUnity, [
  "command",
  "build_status",
  "--project-path",
  projectPath,
  "--format",
  "json",
], "Unity build status");

const waitForBuild = async ({
  buildId,
  invokeUnity,
  logger,
  pollIntervalMs,
  projectPath,
  sleep,
}) => {
  let lastStatus;
  let pollFailures = 0;

  while (true) {
    let status;
    try {
      status = await readBuildStatus(invokeUnity, projectPath);
      pollFailures = 0;
    } catch (error) {
      pollFailures += 1;
      if (pollFailures === 1) {
        logger.warn("Unity build status was temporarily unavailable; continuing to wait safely.");
      }
      await sleep(pollIntervalMs);
      continue;
    }

    if (!status || typeof status !== "object") {
      logger.warn("Unity build status returned an invalid result; continuing to wait safely.");
      await sleep(pollIntervalMs);
      continue;
    }
    if (status.buildId !== buildId) {
      if (ACTIVE_BUILD_STATUSES.has(status.status)) {
        logger.warn("A different Unity build became active; waiting for it before cleanup.");
        await sleep(pollIntervalMs);
        continue;
      }
      throw new Error("Unity build status no longer matches the queued build ID.");
    }
    if (status.status !== lastStatus) {
      logger.log(`Unity WebGL build ${buildId}: ${status.status}.`);
      lastStatus = status.status;
    }
    if (status.status === TERMINAL_BUILD_STATUS) return status;
    if (!ACTIVE_BUILD_STATUSES.has(status.status)) {
      logger.warn(`Unity reported build status '${status.status}'; continuing to wait safely.`);
      await sleep(pollIntervalMs);
      continue;
    }
    await sleep(pollIntervalMs);
  }
};

const waitForAmbiguousSubmissionBarrier = async ({
  invokeUnity,
  logger,
  pollIntervalMs,
  previousBuildId,
  projectPath,
  sleep,
}) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const status = await readBuildStatus(invokeUnity, projectPath);
      if (status?.buildId && status.buildId !== previousBuildId) {
        if (ACTIVE_BUILD_STATUSES.has(status.status)) {
          await waitForBuild({
            buildId: status.buildId,
            invokeUnity,
            logger,
            pollIntervalMs,
            projectPath,
            sleep,
          });
        }
        return;
      }
    } catch {
      // A main-thread pending-build check below provides the final barrier.
    }
    await sleep(pollIntervalMs);
  }

  let consecutiveIdleChecks = 0;
  while (consecutiveIdleChecks < 2) {
    if (await readPendingBuild(invokeUnity, projectPath)) {
      consecutiveIdleChecks = 0;
    } else {
      consecutiveIdleChecks += 1;
    }
    if (consecutiveIdleChecks < 2) await sleep(pollIntervalMs);
  }
};

const assertEditorReady = async (invokeUnity, projectPath) => {
  const result = await commandResult(invokeUnity, [
    "command",
    "editor_status",
    "--project-path",
    projectPath,
    "--format",
    "json",
  ], "Unity Editor status");

  if (
    result?.status !== "ready"
    || result.compiling !== false
    || result.domainReloadInProgress !== false
    || result.playMode !== "stopped"
  ) {
    throw new Error("Unity Editor must be ready, stopped, and finished compiling before a build.");
  }
};

const submitBuild = async (invokeUnity, projectPath, outputPath) => {
  // The Pipeline build command's documented default is exactly
  // DetailedBuildReport. Omitting options also prevents any development,
  // script-debugging, or profiler flag from leaking in through caller state.
  const buildArguments = [
    "command",
    "build",
    "--project-path",
    projectPath,
    "--target",
    "WebGL",
    "--outputPath",
    outputPath,
    "--confirm",
    "true",
  ];
  buildArguments.push("--format", "json");
  const result = await commandResult(
    invokeUnity,
    buildArguments,
    "Unity WebGL build submission",
  );

  if (result?.status !== "queued" || typeof result.buildId !== "string" || !result.buildId) {
    throw new Error("Unity did not queue the WebGL build.");
  }
  return result.buildId;
};

const combineErrors = (primaryError, cleanupErrors) => {
  if (!primaryError && cleanupErrors.length === 0) return null;
  if (primaryError && cleanupErrors.length === 0) return primaryError;
  const details = [primaryError, ...cleanupErrors]
    .filter(Boolean)
    .map((error) => error.message)
    .join(" ");
  return new AggregateError(
    primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
    primaryError
      ? `The Unity build and its guarded cleanup both failed. ${details}`
      : `The Unity build completed, but guarded cleanup failed. ${details}`,
  );
};

export const runGuardedWebGlBuild = async ({
  getInterruptSignal = () => null,
  invokeUnity,
  logger = console,
  outputPath = getDefaultOutputPath(),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  projectPath,
  release = false,
  repoRoot = process.cwd(),
  sleep = sleepFor,
} = {}) => {
  repoRoot = resolve(repoRoot);
  projectPath = resolve(projectPath ?? join(repoRoot, "unity", "three-bosses"));
  outputPath = resolve(outputPath);
  invokeUnity ??= (args) => invokeUnityCli(args, { cwd: repoRoot });
  const [canonicalRepoRoot, canonicalOutputPath] = await Promise.all([
    realpath(repoRoot),
    canonicalizePotentialPath(outputPath),
  ]);
  if (isAtOrInside(canonicalRepoRoot, canonicalOutputPath)) {
    throw new Error("The Unity WebGL output directory must be outside the repository.");
  }
  const projectRelative = relative(repoRoot, projectPath);
  if (!projectRelative || projectRelative.startsWith(`..${sep}`) || isAbsolute(projectRelative)) {
    throw new Error("The Unity project must be inside the repository root.");
  }
  const projectPathspec = normalizeGitPath(projectRelative);
  const guardedRepoPaths = GUARDED_PROJECT_PATHS.map((path) => `${projectPathspec}/${path}`);
  const releaseProvenance = release
    ? markerProvenanceFor(await readCommittedUnityProvenance({ repositoryRoot: repoRoot }))
    : null;

  const releaseLock = await acquireBuildLock(projectPath);
  let baseline;
  let guardedIndexBefore;
  let snapshots;
  let primaryError;
  let previousBuildId;
  let buildStatus;
  let diagnosticAssessment;
  let cleanupBarrierSatisfied = true;
  const cleanupErrors = [];

  try {
    const previousBuildStatus = await readBuildStatus(invokeUnity, projectPath);
    previousBuildId = previousBuildStatus?.buildId;
    if (ACTIVE_BUILD_STATUSES.has(previousBuildStatus?.status)) {
      throw new Error("A Unity build is already queued or running; nothing was changed.");
    }
    if (await readPendingBuild(invokeUnity, projectPath)) {
      throw new Error("A Unity build is pending; nothing was changed.");
    }
    await assertEditorReady(invokeUnity, projectPath);
    await assertGuardedObjectsClean(invokeUnity, projectPath);
    snapshots = await readSnapshots(projectPath);
    [baseline, guardedIndexBefore] = await Promise.all([
      captureUnitySourceState({ repoRoot, projectPathspec }),
      captureGuardedIndex({ repoRoot, guardedRepoPaths }),
    ]);

    if (getInterruptSignal()) throw new Error("Build interrupted before it was queued.");

    await invalidateBuildCompletionMarker(outputPath);
    cleanupBarrierSatisfied = false;
    let buildId;
    try {
      buildId = await submitBuild(invokeUnity, projectPath, outputPath);
    } catch (submissionError) {
      // A local CLI connection can fail after Unity has already queued the
      // build. Observe status repeatedly, then use the Editor's live pending
      // flag/main-thread execution as a safe cleanup barrier.
      await waitForAmbiguousSubmissionBarrier({
        invokeUnity,
        logger,
        pollIntervalMs,
        previousBuildId,
        projectPath,
        sleep,
      });
      cleanupBarrierSatisfied = true;
      throw submissionError;
    }
    logger.log(`Queued guarded Unity WebGL build ${buildId}.`);
    buildStatus = await waitForBuild({
      buildId,
      invokeUnity,
      logger,
      pollIntervalMs,
      projectPath,
      sleep,
    });
    cleanupBarrierSatisfied = true;
    if (buildStatus.result !== "Succeeded") {
      throw new Error(`Unity WebGL build ${buildId} finished with result '${buildStatus.result}'.`);
    }
    diagnosticAssessment = assessSuccessfulBuildDiagnostics(buildStatus);
    if (diagnosticAssessment.acceptedGlobalLightErrors > 0) {
      logger.warn(
        `Accepted ${diagnosticAssessment.acceptedGlobalLightErrors} known scanner-only Global Light diagnostics from com.unity.pipeline.`,
      );
    }
    if (diagnosticAssessment.acceptedPipelineWarnings > 0) {
      logger.log("Runtime Pipeline support is intentionally disabled in the WebGL Player.");
    }
    for (const warning of diagnosticAssessment.actionableWarningMessages) {
      logger.warn(`Unity build warning: ${warning}`);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (snapshots && !cleanupBarrierSatisfied) {
      try {
        await waitForAmbiguousSubmissionBarrier({
          invokeUnity,
          logger,
          pollIntervalMs,
          previousBuildId,
          projectPath,
          sleep,
        });
        cleanupBarrierSatisfied = true;
      } catch (error) {
        cleanupErrors.push(new Error(`Could not prove Unity build completion: ${error.message}`));
      }
    }

    if (snapshots) {
      let restorationAllowed = false;
      if (!cleanupBarrierSatisfied) {
        cleanupErrors.push(new Error(
          "Unity build state is uncertain; guarded settings were deliberately not overwritten.",
        ));
      } else {
        try {
          const guardedIndexAfter = await captureGuardedIndex({ repoRoot, guardedRepoPaths });
          if (guardedIndexAfter !== guardedIndexBefore) {
            throw new Error("The Git index changed for guarded Unity settings during the build; they were not overwritten.");
          }
          restorationAllowed = true;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }

      if (restorationAllowed) {
        try {
          await releaseGuardedFileHandles(invokeUnity, projectPath);
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await restoreSnapshots(snapshots);
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await reimportGuardedObjects(invokeUnity, projectPath);
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          const rewrittenAfterReimport = await restoreSnapshots(snapshots);
          if (rewrittenAfterReimport.length > 0) {
            cleanupErrors.push(new Error(
              `Unity rewrote guarded settings during reimport: ${rewrittenAfterReimport.join(", ")}.`,
            ));
          }
          await verifySnapshots(snapshots);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }

    if (baseline) {
      try {
        const after = await captureUnitySourceState({ repoRoot, projectPathspec });
        const changedPaths = diffUnitySourceStates(baseline, after);
        if (changedPaths.length > 0) {
          throw new Error(`Unexpected Unity source changes: ${changedPaths.join(", ")}.`);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (!primaryError && cleanupErrors.length === 0) {
      try {
        // Publish while the cooperative lock is still held so another guarded
        // build cannot invalidate the output between cleanup and certification.
        let certifiedProvenance;
        if (releaseProvenance) {
          certifiedProvenance = markerProvenanceFor(
            await readCommittedUnityProvenance({ repositoryRoot: repoRoot }),
          );
          if (!sameUnityBuildProvenance(releaseProvenance, certifiedProvenance)) {
            throw new Error("Unity release provenance changed while the WebGL build was running.");
          }
        }
        await writeBuildCompletionMarker(outputPath, {
          provenance: certifiedProvenance,
        });
      } catch (error) {
        cleanupErrors.push(new Error(`Could not certify the completed WebGL build: ${error.message}`));
      }
    }

    try {
      await releaseLock();
    } catch (error) {
      cleanupErrors.push(new Error(`Could not release the guarded build lock: ${error.message}`));
    }
  }

  const finalError = combineErrors(primaryError, cleanupErrors);
  if (finalError) throw finalError;

  const interruptSignal = getInterruptSignal();
  if (interruptSignal) {
    throw new Error(`Unity build cleanup completed after ${interruptSignal}; exiting as interrupted.`);
  }

  return {
    buildId: buildStatus.buildId,
    buildTimeMs: buildStatus.buildTimeMs,
    actionableWarnings: diagnosticAssessment.actionableWarnings,
    acceptedGlobalLightErrors: diagnosticAssessment.acceptedGlobalLightErrors,
    outputPath: buildStatus.outputPath ?? outputPath,
    result: buildStatus.result,
    totalWarnings: buildStatus.totalWarnings ?? 0,
  };
};

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const cliArgs = process.argv.slice(2);
  const release = cliArgs.length === 1 && cliArgs[0] === "--release";
  if (cliArgs.length > 0 && !release) {
    console.error("Usage: build-three-bosses-webgl.mjs [--release]");
    process.exitCode = 1;
  }
  let interruptSignal = null;
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (interruptSignal) return;
      interruptSignal = signal;
      console.warn(`${signal} received; waiting for Unity to finish before restoring guarded settings.`);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    if (process.exitCode) throw new Error("Invalid command-line arguments.");
    const result = await runGuardedWebGlBuild({
      getInterruptSignal: () => interruptSignal,
      release,
    });
    console.log(
      `Unity WebGL build ${result.buildId} succeeded in ${result.buildTimeMs ?? "unknown"} ms `
      + `with ${result.actionableWarnings} actionable warning(s).`,
    );
    console.log(`External build directory: ${result.outputPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = interruptSignal === "SIGINT" ? 130 : interruptSignal === "SIGTERM" ? 143 : 1;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
