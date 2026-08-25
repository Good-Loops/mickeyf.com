import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
  GUARDED_PROJECT_PATHS,
  getDefaultOutputPath,
  parseUnityEnvelope,
  readSnapshots,
  restoreSnapshots,
  runGuardedWebGlBuild,
  verifySnapshots,
} from "./build-three-bosses-webgl.mjs";
import {
  BUILD_COMPLETION_MARKER,
  readBuildManifest,
  writeBuildCompletionMarker,
} from "./serve-three-bosses-webgl.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, {
    force: true,
    recursive: true,
  })));
});

const envelope = (result) => ({
  data: { result, success: true },
  errors: [],
  success: true,
  warnings: [],
});

const evalEnvelope = (result) => envelope({
  diagnostics: [],
  result,
  success: true,
});

const createFixture = async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "three-bosses-build-guard-"));
  temporaryRoots.push(repoRoot);
  const outputPath = await mkdtemp(join(tmpdir(), "three-bosses-build-output-"));
  temporaryRoots.push(outputPath);
  const buildPath = join(outputPath, "Build");
  await mkdir(buildPath);
  await Promise.all([
    writeFile(join(buildPath, "fixture.data.br"), "data"),
    writeFile(join(buildPath, "fixture.framework.js.br"), "framework"),
    writeFile(join(buildPath, "fixture.loader.js"), "loader"),
    writeFile(join(buildPath, "fixture.wasm.br"), "wasm"),
  ]);
  await writeBuildCompletionMarker(outputPath);
  const projectPath = join(repoRoot, "unity", "three-bosses");
  const guardedBytes = new Map([
    [GUARDED_PROJECT_PATHS[0], Buffer.from("%YAML 1.1\r\nps4Passcode: \r\nmarker: \0\xff", "latin1")],
    [GUARDED_PROJECT_PATHS[1], Buffer.from("%YAML 1.1\nshaderPrefilter: clean\n", "utf8")],
    [GUARDED_PROJECT_PATHS[2], Buffer.from([0xef, 0xbb, 0xbf, 0x25, 0x59, 0x41, 0x4d, 0x4c])],
  ]);

  for (const [relativePath, bytes] of guardedBytes) {
    const absolutePath = join(projectPath, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
  }
  const scenePath = join(projectPath, "Assets", "Scenes", "Main.unity");
  await mkdir(dirname(scenePath), { recursive: true });
  await writeFile(scenePath, "scene: baseline\n", "utf8");
  await writeFile(join(repoRoot, ".gitignore"), "unity/three-bosses/Library/\n", "utf8");

  execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: repoRoot });
  execFileSync("git", ["add", "--", ".gitignore", "unity/three-bosses"], { cwd: repoRoot });

  return { guardedBytes, outputPath, projectPath, repoRoot, scenePath };
};

const createFakeUnity = ({
  buildResult = "Succeeded",
  mutateDuringBuild,
  mutateDuringReimport,
  statusBuildId = "build-test",
  transientPollFailure = false,
}) => {
  let buildStatusCalls = 0;
  let transientFailurePending = transientPollFailure;

  return async (args) => {
    const command = args[1];
    if (command === "editor_status") {
      return envelope({
        compiling: false,
        domainReloadInProgress: false,
        playMode: "stopped",
        status: "ready",
      });
    }
    if (command === "eval") {
      const code = args[args.indexOf("--code") + 1];
      if (code.includes('GetField("s_Pending"')) return evalEnvelope("False");
      if (code.includes("ImportAsset(path")) {
        assert.match(code, /var paths = new \[\]/u);
        await mutateDuringReimport?.();
        return evalEnvelope(GUARDED_PROJECT_PATHS.map((path) => `${path}=1,False`).join("\n"));
      }
      if (code.includes("ReleaseCachedFileHandles")) return evalEnvelope("released");
      assert.match(code, /var paths = new \[\]/u);
      return evalEnvelope(GUARDED_PROJECT_PATHS.map((path) => `${path}=1,False`).join("\n"));
    }
    if (command === "build") {
      await mutateDuringBuild?.();
      return envelope({ buildId: "build-test", status: "queued" });
    }
    if (command === "build_status") {
      buildStatusCalls += 1;
      if (buildStatusCalls === 1) {
        return envelope(JSON.stringify({ buildId: "previous-build", result: "Succeeded", status: "completed" }));
      }
      if (transientFailurePending) {
        transientFailurePending = false;
        throw new Error("temporary local connection failure");
      }
      if (buildStatusCalls === (transientPollFailure ? 3 : 2)) {
        return envelope(JSON.stringify({ buildId: statusBuildId, status: "building" }));
      }
      return envelope(JSON.stringify({
        buildId: statusBuildId,
        buildTimeMs: 123,
        outputPath: "external-build",
        result: buildResult,
        status: "completed",
        totalWarnings: 2,
      }));
    }
    throw new Error(`Unexpected fake Unity command: ${command}`);
  };
};

const mutateGuardedFiles = async (projectPath) => {
  await Promise.all(GUARDED_PROJECT_PATHS.map((path) =>
    writeFile(join(projectPath, path), `Unity churn in ${path}\n`, "utf8")));
};

const quietLogger = () => {
  const messages = [];
  return {
    logger: {
      log: (message) => messages.push(String(message)),
      warn: (message) => messages.push(String(message)),
    },
    messages,
  };
};

test("parses object and nested-string Unity command results", () => {
  assert.deepEqual(parseUnityEnvelope(envelope({ status: "queued" })), { status: "queued" });
  assert.deepEqual(
    parseUnityEnvelope(JSON.stringify(envelope(JSON.stringify({ status: "building" })))),
    { status: "building" },
  );
  assert.throws(() => parseUnityEnvelope("not JSON"), /malformed JSON/u);
  assert.throws(() => parseUnityEnvelope({ success: false }), /failed/u);
});

test("uses the shared WebGL directory override for build output", () => {
  assert.equal(
    getDefaultOutputPath({
      LOCALAPPDATA: "ignored-local-app-data",
      THREE_BOSSES_WEBGL_DIR: "custom-webgl-output",
    }),
    "custom-webgl-output",
  );
});

test("restores arbitrary guarded bytes exactly and does not rewrite unchanged files", async () => {
  const { projectPath } = await createFixture();
  const snapshots = await readSnapshots(projectPath);
  const unchangedPath = snapshots[1].absolutePath;
  const unchangedMtime = (await stat(unchangedPath)).mtimeMs;

  await writeFile(snapshots[0].absolutePath, "changed", "utf8");
  const restored = await restoreSnapshots(snapshots);
  await verifySnapshots(snapshots);

  assert.deepEqual(restored, [snapshots[0].relativePath]);
  assert.equal((await stat(unchangedPath)).mtimeMs, unchangedMtime);
});

test("restores the exact pre-build working bytes after a successful build", async () => {
  const { guardedBytes, outputPath, projectPath, repoRoot } = await createFixture();
  const { logger, messages } = quietLogger();
  const invokeUnity = createFakeUnity({
    mutateDuringBuild: async () => {
      await assert.rejects(
        () => readFile(join(outputPath, BUILD_COMPLETION_MARKER)),
        (error) => error.code === "ENOENT",
      );
      await mutateGuardedFiles(projectPath);
    },
    transientPollFailure: true,
  });

  const result = await runGuardedWebGlBuild({
    invokeUnity,
    logger,
    outputPath,
    pollIntervalMs: 0,
    repoRoot,
    sleep: async () => {},
  });

  assert.equal(result.result, "Succeeded");
  assert.match((await readBuildManifest(outputPath)).loaderUrl, /\?buildId=/u);
  for (const [relativePath, expected] of guardedBytes) {
    assert.deepEqual(await readFile(join(projectPath, relativePath)), expected);
  }
  const combinedLogs = messages.join("\n");
  assert.equal(combinedLogs.includes("ps4Passcode"), false);
  assert.match(combinedLogs, /temporarily unavailable/u);
});

test("restores guarded settings when Unity reports a failed build", async () => {
  const { guardedBytes, outputPath, projectPath, repoRoot } = await createFixture();
  const invokeUnity = createFakeUnity({
    buildResult: "Failed",
    mutateDuringBuild: () => mutateGuardedFiles(projectPath),
  });

  await assert.rejects(() => runGuardedWebGlBuild({
    invokeUnity,
    logger: quietLogger().logger,
    outputPath,
    pollIntervalMs: 0,
    projectPath,
    repoRoot,
    sleep: async () => {},
  }), /finished with result 'Failed'/u);

  for (const [relativePath, expected] of guardedBytes) {
    assert.deepEqual(await readFile(join(projectPath, relativePath)), expected);
  }
  await assert.rejects(
    () => readFile(join(outputPath, BUILD_COMPLETION_MARKER)),
    (error) => error.code === "ENOENT",
  );
});

test("leaves unexpected Unity source changes intact and fails with their path", async () => {
  const { outputPath, projectPath, repoRoot, scenePath } = await createFixture();
  const invokeUnity = createFakeUnity({
    mutateDuringBuild: async () => {
      await mutateGuardedFiles(projectPath);
      await writeFile(scenePath, "scene: unexpected build mutation\n", "utf8");
    },
  });

  await assert.rejects(() => runGuardedWebGlBuild({
    invokeUnity,
    logger: quietLogger().logger,
    outputPath,
    pollIntervalMs: 0,
    projectPath,
    repoRoot,
    sleep: async () => {},
  }), /unity\/three-bosses\/Assets\/Scenes\/Main\.unity/u);
  assert.equal(await readFile(scenePath, "utf8"), "scene: unexpected build mutation\n");
});

test("never accepts a completed status belonging to another build", async () => {
  const { guardedBytes, outputPath, projectPath, repoRoot } = await createFixture();
  const invokeUnity = createFakeUnity({
    mutateDuringBuild: () => mutateGuardedFiles(projectPath),
    statusBuildId: "different-build",
  });

  await assert.rejects(() => runGuardedWebGlBuild({
    invokeUnity,
    logger: quietLogger().logger,
    outputPath,
    pollIntervalMs: 0,
    projectPath,
    repoRoot,
    sleep: async () => {},
  }), /no longer matches the queued build ID/u);
  for (const [relativePath, expected] of guardedBytes) {
    assert.deepEqual(await readFile(join(projectPath, relativePath)), expected);
  }
});

test("does not overwrite guarded files if their Git index entries changed", async () => {
  const { outputPath, projectPath, repoRoot } = await createFixture();
  const guardedPath = join(projectPath, GUARDED_PROJECT_PATHS[0]);
  const invokeUnity = createFakeUnity({
    mutateDuringBuild: async () => {
      await mutateGuardedFiles(projectPath);
      execFileSync("git", ["add", "--", `unity/three-bosses/${GUARDED_PROJECT_PATHS[0]}`], {
        cwd: repoRoot,
      });
    },
  });

  await assert.rejects(() => runGuardedWebGlBuild({
    invokeUnity,
    logger: quietLogger().logger,
    outputPath,
    pollIntervalMs: 0,
    projectPath,
    repoRoot,
    sleep: async () => {},
  }), /Git index changed for guarded Unity settings/u);
  assert.match(await readFile(guardedPath, "utf8"), /Unity churn/u);
});

test("refuses a pre-existing active build before snapshotting or submitting", async () => {
  const { outputPath, projectPath, repoRoot } = await createFixture();
  let buildSubmitted = false;
  const invokeUnity = async (args) => {
    if (args[1] === "build_status") {
      return envelope(JSON.stringify({ buildId: "existing-build", status: "building" }));
    }
    if (args[1] === "build") buildSubmitted = true;
    throw new Error(`Unexpected command during active-build refusal: ${args[1]}`);
  };

  await assert.rejects(() => runGuardedWebGlBuild({
    invokeUnity,
    logger: quietLogger().logger,
    outputPath,
    pollIntervalMs: 0,
    projectPath,
    repoRoot,
    sleep: async () => {},
  }), /already queued or running/u);
  assert.equal(buildSubmitted, false);
});

test("waits for a lost-response build to finish before restoring", async () => {
  const { guardedBytes, outputPath, projectPath, repoRoot } = await createFixture();
  let buildStatusCalls = 0;
  let terminalReached = false;
  const invokeUnity = async (args) => {
    const command = args[1];
    if (command === "build_status") {
      buildStatusCalls += 1;
      if (buildStatusCalls === 1) {
        return envelope(JSON.stringify({ buildId: "previous-build", status: "completed" }));
      }
      if (buildStatusCalls === 2) throw new Error("temporary status loss");
      if (buildStatusCalls === 3) {
        return envelope(JSON.stringify({ buildId: "lost-response-build", status: "queued" }));
      }
      if (buildStatusCalls === 4) {
        return envelope(JSON.stringify({ buildId: "lost-response-build", status: "building" }));
      }
      terminalReached = true;
      return envelope(JSON.stringify({
        buildId: "lost-response-build",
        result: "Succeeded",
        status: "completed",
      }));
    }
    if (command === "editor_status") {
      return envelope({
        compiling: false,
        domainReloadInProgress: false,
        playMode: "stopped",
        status: "ready",
      });
    }
    if (command === "build") {
      await mutateGuardedFiles(projectPath);
      throw new Error("build response was lost");
    }
    if (command === "eval") {
      const code = args[args.indexOf("--code") + 1];
      if (code.includes('GetField("s_Pending"')) return evalEnvelope("False");
      if (code.includes("ImportAsset(path")) {
        return evalEnvelope(GUARDED_PROJECT_PATHS.map((path) => `${path}=1,False`).join("\n"));
      }
      if (code.includes("ReleaseCachedFileHandles")) {
        assert.equal(terminalReached, true);
        return evalEnvelope("released");
      }
      return evalEnvelope(GUARDED_PROJECT_PATHS.map((path) => `${path}=1,False`).join("\n"));
    }
    throw new Error(`Unexpected fake Unity command: ${command}`);
  };

  await assert.rejects(() => runGuardedWebGlBuild({
    invokeUnity,
    logger: quietLogger().logger,
    outputPath,
    pollIntervalMs: 0,
    projectPath,
    repoRoot,
    sleep: async () => {},
  }), /build response was lost/u);
  assert.equal(terminalReached, true);
  for (const [relativePath, expected] of guardedBytes) {
    assert.deepEqual(await readFile(join(projectPath, relativePath)), expected);
  }
});

test("leaves exact snapshot bytes if targeted reimport rewrites a guarded file", async () => {
  const { guardedBytes, outputPath, projectPath, repoRoot } = await createFixture();
  const rewrittenPath = join(projectPath, GUARDED_PROJECT_PATHS[1]);
  const invokeUnity = createFakeUnity({
    mutateDuringBuild: () => mutateGuardedFiles(projectPath),
    mutateDuringReimport: () => writeFile(rewrittenPath, "reimport rewrite\n", "utf8"),
  });

  await assert.rejects(() => runGuardedWebGlBuild({
    invokeUnity,
    logger: quietLogger().logger,
    outputPath,
    pollIntervalMs: 0,
    projectPath,
    repoRoot,
    sleep: async () => {},
  }), /rewrote guarded settings during reimport/u);
  for (const [relativePath, expected] of guardedBytes) {
    assert.deepEqual(await readFile(join(projectPath, relativePath)), expected);
  }
  await assert.rejects(
    () => readFile(join(outputPath, BUILD_COMPLETION_MARKER)),
    (error) => error.code === "ENOENT",
  );
});

test("rejects a WebGL output directory inside the repository before Unity runs", async () => {
  const { projectPath, repoRoot } = await createFixture();
  let unityInvoked = false;

  await assert.rejects(() => runGuardedWebGlBuild({
    invokeUnity: async () => {
      unityInvoked = true;
      throw new Error("Unity should not be invoked");
    },
    outputPath: join(repoRoot, "generated-webgl"),
    projectPath,
    repoRoot,
  }), /must be outside the repository/u);
  assert.equal(unityInvoked, false);
});

test("does not restore when a lost submission cannot reach a safe Unity barrier", async () => {
  const { outputPath, projectPath, repoRoot } = await createFixture();
  const guardedPath = join(projectPath, GUARDED_PROJECT_PATHS[0]);
  let initialStatusRead = true;
  const invokeUnity = async (args) => {
    const command = args[1];
    if (command === "build_status") {
      if (initialStatusRead) {
        initialStatusRead = false;
        return envelope(JSON.stringify({ buildId: "previous-build", status: "completed" }));
      }
      throw new Error("status unavailable");
    }
    if (command === "editor_status") {
      return envelope({
        compiling: false,
        domainReloadInProgress: false,
        playMode: "stopped",
        status: "ready",
      });
    }
    if (command === "build") {
      await mutateGuardedFiles(projectPath);
      throw new Error("submission response lost");
    }
    if (command === "eval") {
      const code = args[args.indexOf("--code") + 1];
      if (code.includes('GetField("s_Pending"')) {
        // The first call is the pre-build pending check; the second is the
        // ambiguous-submission barrier and cannot be trusted.
        invokeUnity.pendingCalls = (invokeUnity.pendingCalls ?? 0) + 1;
        if (invokeUnity.pendingCalls > 1) throw new Error("pending state unavailable");
        return evalEnvelope("False");
      }
      return evalEnvelope(GUARDED_PROJECT_PATHS.map((path) => `${path}=1,False`).join("\n"));
    }
    throw new Error(`Unexpected fake Unity command: ${command}`);
  };

  await assert.rejects(() => runGuardedWebGlBuild({
    invokeUnity,
    logger: quietLogger().logger,
    outputPath,
    pollIntervalMs: 0,
    projectPath,
    repoRoot,
    sleep: async () => {},
  }), /guarded settings were deliberately not overwritten/u);
  assert.match(await readFile(guardedPath, "utf8"), /Unity churn/u);
});
