import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  acquireWebGlPackageLock,
  assertWebGlReleaseResourceCaps,
  digestUnitySourceEntries,
  packageThreeBossesWebGlRelease,
  publishManifestAtomically,
  publishReleaseDirectoryAtomically,
  removeReleaseDirectoryWithRetry,
  REQUIRED_UNITY_EDITOR_VERSION,
  runThreeBossesWebGlReleaseCli,
  validatePackagedThreeBossesWebGlRelease,
} from "./package-three-bosses-webgl-release.mjs";
import { writeBuildCompletionMarker } from "./serve-three-bosses-webgl.mjs";
import {
  markerProvenanceFor,
  readCommittedUnityProvenance,
} from "./three-bosses-unity-provenance.mjs";

const executeFile = promisify(execFile);
const temporaryRoots = [];
let currentRepositoryRoot;

const run = async (command, args, options = {}) => executeFile(command, args, {
  encoding: "utf8",
  windowsHide: true,
  ...options,
});

const git = (repositoryRoot, args) => run("git", ["-C", repositoryRoot, ...args]);

const createRepository = async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "three-bosses-release-repo-"));
  currentRepositoryRoot = repositoryRoot;
  temporaryRoots.push(repositoryRoot);

  await mkdir(join(repositoryRoot, "unity", "three-bosses", "Assets"), { recursive: true });
  await mkdir(join(repositoryRoot, "unity", "three-bosses", "Packages"), { recursive: true });
  await mkdir(join(repositoryRoot, "unity", "three-bosses", "ProjectSettings"), { recursive: true });
  await writeFile(
    join(repositoryRoot, "unity", "three-bosses", "Assets", "Game.cs"),
    "public sealed class Game {}\n",
  );
  await writeFile(
    join(repositoryRoot, "unity", "three-bosses", "Assets", "Game.cs.meta"),
    "fileFormatVersion: 2\n",
  );
  await writeFile(
    join(repositoryRoot, "unity", "three-bosses", "Packages", "manifest.json"),
    "{}\n",
  );
  await writeFile(
    join(repositoryRoot, "unity", "three-bosses", "ProjectSettings", "ProjectSettings.asset"),
    "PlayerSettings: {}\n",
  );
  await writeFile(
    join(repositoryRoot, "unity", "three-bosses", "ProjectSettings", "ProjectVersion.txt"),
    `m_EditorVersion: ${REQUIRED_UNITY_EDITOR_VERSION}\n`,
  );
  await writeFile(
    join(repositoryRoot, ".gitattributes"),
    "/frontend/public/unity/three-bosses/releases/** -text -eol\n",
  );

  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Release Test"]);
  await git(repositoryRoot, ["config", "user.email", "release-test@example.invalid"]);
  await git(repositoryRoot, ["add", ".gitattributes", "unity/three-bosses"]);
  await git(repositoryRoot, ["commit", "-m", "Add Three Bosses source"]);
  return repositoryRoot;
};

const createCertifiedBuild = async ({
  repositoryRoot = currentRepositoryRoot,
  streamingAssets = false,
} = {}) => {
  const externalBuildRoot = await mkdtemp(join(tmpdir(), "three-bosses-release-build-"));
  temporaryRoots.push(externalBuildRoot);

  await mkdir(join(externalBuildRoot, "Build"));
  await mkdir(join(externalBuildRoot, "TemplateData"));
  await writeFile(join(externalBuildRoot, "index.html"), "<!doctype html>\n");
  await writeFile(join(externalBuildRoot, "TemplateData", "style.css"), "body {}\n");
  await writeFile(join(externalBuildRoot, "Build", "game.loader.js"), "loader\n");
  await writeFile(join(externalBuildRoot, "Build", "game.data.br"), "data\n");
  await writeFile(join(externalBuildRoot, "Build", "game.framework.js.br"), "framework\n");
  await writeFile(join(externalBuildRoot, "Build", "game.wasm.br"), "wasm\n");

  if (streamingAssets) {
    await mkdir(join(externalBuildRoot, "StreamingAssets", "catalog"), { recursive: true });
    await writeFile(
      join(externalBuildRoot, "StreamingAssets", "catalog", "levels.json"),
      "{\"levels\":3}\n",
    );
  }

  const provenance = markerProvenanceFor(
    await readCommittedUnityProvenance({ repositoryRoot }),
  );
  await writeBuildCompletionMarker(externalBuildRoot, { provenance });
  return externalBuildRoot;
};

const packageFixture = async ({ repositoryRoot, externalBuildRoot }) => {
  const publicRoot = join(repositoryRoot, "frontend", "public", "unity", "three-bosses");
  return packageThreeBossesWebGlRelease({
    repositoryRoot,
    externalBuildRoot,
    publicRoot,
  });
};

const writeManifest = async (packaged, mutate) => {
  const manifest = structuredClone(packaged.manifest);
  mutate(manifest);
  await writeFile(packaged.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) =>
    rm(path, { force: true, recursive: true })));
});

test("packages one verified content-addressed release with provenance", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();

  const first = await packageFixture({ repositoryRoot, externalBuildRoot });
  const second = await packageFixture({ repositoryRoot, externalBuildRoot });

  assert.equal(first.buildId, second.buildId);
  assert.match(first.buildId, /^[a-f0-9]{64}$/u);
  assert.equal(first.manifest.unityEditorVersion, REQUIRED_UNITY_EDITOR_VERSION);
  assert.match(first.manifest.sourceCommit, /^[a-f0-9]{40,64}$/u);
  assert.match(first.manifest.unitySourceDigest, /^[a-f0-9]{64}$/u);
  assert.equal(first.manifest.unitySourceFileCount, 5);
  assert.equal(first.manifest.assets.length, 4);
  assert.ok(first.manifest.loaderUrl.startsWith(`releases/${first.buildId}/Build/`));
  assert.equal(
    first.manifest.streamingAssetsUrl,
    `releases/${first.buildId}/StreamingAssets`,
  );

  for (const asset of first.manifest.assets) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(asset.size));
    await readFile(join(
      repositoryRoot,
      "frontend",
      "public",
      "unity",
      "three-bosses",
      ...asset.path.split("/"),
    ));
  }

  const stableManifest = JSON.parse(await readFile(first.manifestPath, "utf8"));
  assert.deepEqual(stableManifest, first.manifest);

  const validated = await validatePackagedThreeBossesWebGlRelease({
    repositoryRoot,
    publicRoot: join(repositoryRoot, "frontend", "public", "unity", "three-bosses"),
  });
  assert.equal(validated.buildId, first.buildId);
});

test("rejects an external build outside trusted local roots", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = resolve(parse(homedir()).root, "three-bosses-untrusted-build");

  await assert.rejects(
    () => packageFixture({ repositoryRoot, externalBuildRoot }),
    /must stay inside the user or temporary directory/u,
  );
});

test("keeps only the current packaged release after a content change", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  const first = await packageFixture({ repositoryRoot, externalBuildRoot });
  await writeFile(join(externalBuildRoot, "Build", "game.data.br"), "different data\n");
  await writeBuildCompletionMarker(externalBuildRoot, {
    provenance: markerProvenanceFor(
      await readCommittedUnityProvenance({ repositoryRoot }),
    ),
  });
  const second = await packageFixture({ repositoryRoot, externalBuildRoot });

  assert.notEqual(second.buildId, first.buildId);
  assert.deepEqual(
    await readdir(join(repositoryRoot, "frontend", "public", "unity", "three-bosses", "releases")),
    [second.buildId],
  );
});

test("validator rejects stale extra release directories", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  const packaged = await packageFixture({ repositoryRoot, externalBuildRoot });
  await mkdir(join(
    repositoryRoot,
    "frontend",
    "public",
    "unity",
    "three-bosses",
    "releases",
    packaged.buildId === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64),
  ));

  await assert.rejects(
    () => validatePackagedThreeBossesWebGlRelease({
      repositoryRoot,
      publicRoot: join(repositoryRoot, "frontend", "public", "unity", "three-bosses"),
    }),
    /exactly the current release/u,
  );
});

test("packaging rejects a local-only marker without release provenance", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  await writeBuildCompletionMarker(externalBuildRoot);

  await assert.rejects(
    () => packageFixture({ repositoryRoot, externalBuildRoot }),
    /provenance-bound release completion marker/u,
  );
});

test("an unrelated post-build commit does not invalidate an unchanged Unity release", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  await writeFile(join(repositoryRoot, "README.md"), "Unrelated frontend or docs work.\n");
  await git(repositoryRoot, ["add", "README.md"]);
  await git(repositoryRoot, ["commit", "-m", "Add unrelated documentation"]);

  const packaged = await packageFixture({ repositoryRoot, externalBuildRoot });
  const currentHead = (await git(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
  assert.notEqual(packaged.manifest.sourceCommit, currentHead);
  await validatePackagedThreeBossesWebGlRelease({
    repositoryRoot,
    publicRoot: join(repositoryRoot, "frontend", "public", "unity", "three-bosses"),
  });
});

test("retries transient Windows directory locks without weakening atomic publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "three-bosses-release-rename-"));
  temporaryRoots.push(root);
  const stagingPath = join(root, ".release.tmp");
  const releasePath = join(root, "release");
  const relativePath = "Build/game.loader.js";
  const contents = "loader\n";
  await mkdir(join(stagingPath, "Build"), { recursive: true });
  await writeFile(join(stagingPath, ...relativePath.split("/")), contents);

  let attempts = 0;
  const retryDelays = [];
  await publishReleaseDirectoryAtomically({
    stagingPath,
    releasePath,
    expectedAssets: [{
      relativePath,
      sha256: createHash("sha256").update(contents).digest("hex"),
      size: Buffer.byteLength(contents),
    }],
    renameDirectory: async (source, destination) => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("Directory is temporarily locked.");
        error.code = "EPERM";
        throw error;
      }
      await rename(source, destination);
    },
    waitForRetry: async (delayMs) => {
      retryDelays.push(delayMs);
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(retryDelays, [25, 100]);
  assert.equal(await readFile(join(releasePath, ...relativePath.split("/")), "utf8"), contents);
});

test("fails closed instead of copying across filesystems", async () => {
  const root = await mkdtemp(join(tmpdir(), "three-bosses-release-cross-device-"));
  temporaryRoots.push(root);
  const stagingPath = join(root, ".release.tmp");
  const releasePath = join(root, "release");
  await mkdir(stagingPath);

  const crossDeviceError = new Error("Cross-device publication is not atomic.");
  crossDeviceError.code = "EXDEV";
  await assert.rejects(
    () => publishReleaseDirectoryAtomically({
      stagingPath,
      releasePath,
      expectedAssets: [],
      renameDirectory: async () => {
        throw crossDeviceError;
      },
      waitForRetry: async () => {
        assert.fail("EXDEV must not be retried.");
      },
    }),
    (error) => error === crossDeviceError,
  );
  assert.equal(await lstat(stagingPath).then((stats) => stats.isDirectory()), true);
});

test("manifest replacement retries bounded locks and preserves the old manifest on EXDEV", async () => {
  const root = await mkdtemp(join(tmpdir(), "three-bosses-manifest-rename-"));
  temporaryRoots.push(root);
  const manifestPath = join(root, "build-manifest.json");
  let stagingPath = join(root, ".manifest.tmp");
  await writeFile(manifestPath, "old manifest\n");
  await writeFile(stagingPath, "new manifest\n");

  let attempts = 0;
  const retryDelays = [];
  await publishManifestAtomically({
    stagingPath,
    manifestPath,
    renameFile: async (source, destination) => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("File is temporarily locked.");
        error.code = "EBUSY";
        throw error;
      }
      await rename(source, destination);
    },
    waitForRetry: async (delayMs) => retryDelays.push(delayMs),
  });
  assert.equal(await readFile(manifestPath, "utf8"), "new manifest\n");
  assert.deepEqual(retryDelays, [25, 100]);

  stagingPath = join(root, ".manifest-cross-device.tmp");
  await writeFile(stagingPath, "never published\n");
  const crossDeviceError = new Error("Cross-device rename.");
  crossDeviceError.code = "EXDEV";
  await assert.rejects(
    () => publishManifestAtomically({
      stagingPath,
      manifestPath,
      renameFile: async () => { throw crossDeviceError; },
      waitForRetry: async () => assert.fail("EXDEV must not be retried."),
    }),
    (error) => error === crossDeviceError,
  );
  assert.equal(await readFile(manifestPath, "utf8"), "new manifest\n");
});

test("stale release cleanup retries bounded Windows locks", async () => {
  let attempts = 0;
  const retryDelays = [];
  await removeReleaseDirectoryWithRetry({
    releasePath: "unused-test-path",
    removeDirectory: async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("Directory is locked.");
        error.code = "EPERM";
        throw error;
      }
    },
    waitForRetry: async (delayMs) => retryDelays.push(delayMs),
  });
  assert.equal(attempts, 3);
  assert.deepEqual(retryDelays, [25, 100]);
});

test("exclusive package lock rejects an interleaving transaction", async () => {
  const stagingRoot = await mkdtemp(join(tmpdir(), "three-bosses-package-lock-"));
  temporaryRoots.push(stagingRoot);
  const releaseFirst = await acquireWebGlPackageLock({ stagingRoot });
  await assert.rejects(
    () => acquireWebGlPackageLock({ stagingRoot }),
    /packaging transaction is active/u,
  );
  await releaseFirst();

  const releaseSecond = await acquireWebGlPackageLock({ stagingRoot });
  await releaseSecond();
});

test("validates a packaged release after its artifact commit", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  const packaged = await packageFixture({ repositoryRoot, externalBuildRoot });
  await git(repositoryRoot, ["add", "frontend/public"]);
  await git(repositoryRoot, ["commit", "-m", "Add certified WebGL release"]);

  const validated = await validatePackagedThreeBossesWebGlRelease({
    repositoryRoot,
    publicRoot: join(repositoryRoot, "frontend", "public", "unity", "three-bosses"),
  });
  assert.equal(validated.buildId, packaged.buildId);
});

test("validates from a true depth-one checkout after a later artifact commit", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  const packaged = await packageFixture({ repositoryRoot, externalBuildRoot });
  await git(repositoryRoot, ["add", "frontend/public"]);
  await git(repositoryRoot, ["commit", "-m", "Add certified WebGL artifact"]);

  const cloneParent = await mkdtemp(join(tmpdir(), "three-bosses-depth-one-parent-"));
  temporaryRoots.push(cloneParent);
  const cloneRoot = join(cloneParent, "checkout");
  await run("git", [
    "clone",
    "--depth=1",
    pathToFileURL(repositoryRoot).href,
    cloneRoot,
  ]);
  const shallow = (await git(
    cloneRoot,
    ["rev-parse", "--is-shallow-repository"],
  )).stdout.trim();
  assert.equal(shallow, "true");

  const validated = await validatePackagedThreeBossesWebGlRelease({
    repositoryRoot: cloneRoot,
    publicRoot: join(cloneRoot, "frontend", "public", "unity", "three-bosses"),
  });
  assert.equal(validated.buildId, packaged.buildId);
});

test("validation-only CLI path never reads the external build", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  const packaged = await packageFixture({ repositoryRoot, externalBuildRoot });
  const result = await runThreeBossesWebGlReleaseCli({
    args: ["--validate-packaged"],
    repositoryRoot,
    externalBuildRoot: join(repositoryRoot, "does-not-exist"),
    publicRoot: join(repositoryRoot, "frontend", "public", "unity", "three-bosses"),
  });

  assert.equal(result.operation, "validate");
  assert.equal(result.buildId, packaged.buildId);
});

test("rejects manifest schema additions", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  const packaged = await packageFixture({ repositoryRoot, externalBuildRoot });
  await writeManifest(packaged, (manifest) => {
    manifest.unreviewed = true;
  });

  await assert.rejects(
    () => validatePackagedThreeBossesWebGlRelease({
      repositoryRoot,
      publicRoot: join(repositoryRoot, "frontend", "public", "unity", "three-bosses"),
    }),
    /exact release schema/u,
  );
});

test("rejects the obsolete packaged manifest version one", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  const packaged = await packageFixture({ repositoryRoot, externalBuildRoot });
  await writeManifest(packaged, (manifest) => {
    manifest.version = 1;
  });
  await assert.rejects(
    () => validatePackagedThreeBossesWebGlRelease({
      repositoryRoot,
      publicRoot: join(repositoryRoot, "frontend", "public", "unity", "three-bosses"),
    }),
    /unsupported version/u,
  );
});

test("rejects a runtime URL that does not match the content-addressed asset path", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  const packaged = await packageFixture({ repositoryRoot, externalBuildRoot });
  await writeManifest(packaged, (manifest) => {
    manifest.loaderUrl = "releases/not-the-release/Build/game.loader.js";
  });

  await assert.rejects(
    () => validatePackagedThreeBossesWebGlRelease({
      repositoryRoot,
      publicRoot: join(repositoryRoot, "frontend", "public", "unity", "three-bosses"),
    }),
    /loaderUrl does not match/u,
  );
});

test("rejects URL-special characters in packaged manifest asset paths", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  const packaged = await packageFixture({ repositoryRoot, externalBuildRoot });
  for (const unsafeName of ["%2e%2e", "fragment#asset"]) {
    await writeManifest(packaged, (manifest) => {
      manifest.assets[0].path = `releases/${manifest.buildId}/Build/${unsafeName}`;
    });
    await assert.rejects(
      () => validatePackagedThreeBossesWebGlRelease({
        repositoryRoot,
        publicRoot: join(repositoryRoot, "frontend", "public", "unity", "three-bosses"),
      }),
      /unsafe URL path/u,
    );
  }
});

test("rejects provenance that does not match current committed Unity source", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  await packageFixture({ repositoryRoot, externalBuildRoot });
  await writeFile(
    join(repositoryRoot, "unity", "three-bosses", "Assets", "Game.cs"),
    "public sealed class ChangedAfterRelease {}\n",
  );
  await git(repositoryRoot, ["add", "unity/three-bosses"]);
  await git(repositoryRoot, ["commit", "-m", "Change Unity source after packaging"]);

  await assert.rejects(
    () => validatePackagedThreeBossesWebGlRelease({
      repositoryRoot,
      publicRoot: join(repositoryRoot, "frontend", "public", "unity", "three-bosses"),
    }),
    /provenance does not match/u,
  );
});

test("rejects a release ID that does not match listed asset metadata", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  const packaged = await packageFixture({ repositoryRoot, externalBuildRoot });
  await writeManifest(packaged, (manifest) => {
    manifest.assets[0].size += 1;
  });

  await assert.rejects(
    () => validatePackagedThreeBossesWebGlRelease({
      repositoryRoot,
      publicRoot: join(repositoryRoot, "frontend", "public", "unity", "three-bosses"),
    }),
    /release ID does not match/u,
  );
});

test("rejects changed, extra, and missing packaged files", async (t) => {
  await t.test("changed file", async () => {
    const repositoryRoot = await createRepository();
    const externalBuildRoot = await createCertifiedBuild();
    const packaged = await packageFixture({ repositoryRoot, externalBuildRoot });
    await writeFile(join(packaged.releasePath, "Build", "game.loader.js"), "changed\n");

    await assert.rejects(
      () => validatePackagedThreeBossesWebGlRelease({
        repositoryRoot,
        publicRoot: join(repositoryRoot, "frontend", "public", "unity", "three-bosses"),
      }),
      /verification failed/u,
    );
  });

  await t.test("extra file", async () => {
    const repositoryRoot = await createRepository();
    const externalBuildRoot = await createCertifiedBuild();
    const packaged = await packageFixture({ repositoryRoot, externalBuildRoot });
    await writeFile(join(packaged.releasePath, "Build", "extra.bin"), "extra\n");

    await assert.rejects(
      () => validatePackagedThreeBossesWebGlRelease({
        repositoryRoot,
        publicRoot: join(repositoryRoot, "frontend", "public", "unity", "three-bosses"),
      }),
      /unexpected file set/u,
    );
  });

  await t.test("missing file", async () => {
    const repositoryRoot = await createRepository();
    const externalBuildRoot = await createCertifiedBuild();
    const packaged = await packageFixture({ repositoryRoot, externalBuildRoot });
    await rm(join(packaged.releasePath, "Build", "game.data.br"));

    await assert.rejects(
      () => validatePackagedThreeBossesWebGlRelease({
        repositoryRoot,
        publicRoot: join(repositoryRoot, "frontend", "public", "unity", "three-bosses"),
      }),
      /unexpected file set/u,
    );
  });
});

test("rejects symlinks in the packaged release", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  const packaged = await packageFixture({ repositoryRoot, externalBuildRoot });
  const outside = await mkdtemp(join(tmpdir(), "three-bosses-packaged-outside-"));
  temporaryRoots.push(outside);
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await symlink(
    outside,
    join(packaged.releasePath, "escaped"),
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    () => validatePackagedThreeBossesWebGlRelease({
      repositoryRoot,
      publicRoot: join(repositoryRoot, "frontend", "public", "unity", "three-bosses"),
    }),
    /symbolic link/u,
  );
});

test("rejects a linked Unity source-root ancestor", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  const assetsPath = join(repositoryRoot, "unity", "three-bosses", "Assets");
  const outside = await mkdtemp(join(tmpdir(), "three-bosses-source-outside-"));
  temporaryRoots.push(outside);
  await writeFile(join(outside, "Game.cs"), "public sealed class Game {}\n");
  await writeFile(join(outside, "Game.cs.meta"), "fileFormatVersion: 2\n");
  await rm(assetsPath, { recursive: true });
  await symlink(
    outside,
    assetsPath,
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    () => packageFixture({ repositoryRoot, externalBuildRoot }),
    /linked or invalid ancestor/u,
  );
});

test("source digest is deterministic regardless of entry order", () => {
  const entries = [
    { mode: "100644", objectId: "b".repeat(40), path: "unity/three-bosses/Z.cs" },
    { mode: "100644", objectId: "a".repeat(40), path: "unity/three-bosses/A.cs" },
  ];

  assert.equal(
    digestUnitySourceEntries(entries),
    digestUnitySourceEntries([...entries].reverse()),
  );
});

test("enforces deploy entry, per-file, and total resource caps at their boundaries", () => {
  assert.doesNotThrow(() => assertWebGlReleaseResourceCaps([
    { relativePath: "Build/game.data.br", size: 32 * 1024 * 1024 },
    { relativePath: "Build/game.wasm.br", size: 16 * 1024 * 1024 },
    { relativePath: "Build/game.framework.js.br", size: 16 * 1024 * 1024 },
  ]));
  assert.doesNotThrow(() => assertWebGlReleaseResourceCaps(
    Array.from({ length: 2_000 }, (_, index) => ({
      relativePath: `Build/asset-${index}.bin`,
      size: 1,
    })),
  ));
  assert.throws(() => assertWebGlReleaseResourceCaps([
    { relativePath: "Build/game.data.br", size: (32 * 1024 * 1024) + 1 },
  ]), /per-file size cap/u);
  assert.throws(() => assertWebGlReleaseResourceCaps([
    { relativePath: "Build/game.wasm.br", size: (16 * 1024 * 1024) + 1 },
  ]), /per-file size cap/u);
  assert.throws(() => assertWebGlReleaseResourceCaps([
    { relativePath: "Build/game.data.br", size: 32 * 1024 * 1024 },
    { relativePath: "Build/game.wasm.br", size: 16 * 1024 * 1024 },
    { relativePath: "Build/game.framework.js.br", size: 16 * 1024 * 1024 },
    { relativePath: "Build/game.loader.js", size: 1 },
  ]), /64 MiB/u);
  assert.throws(() => assertWebGlReleaseResourceCaps(
    Array.from({ length: 2_001 }, (_, index) => ({
      relativePath: `Build/asset-${index}.bin`,
      size: 1,
    })),
  ), /2000-file/u);
});

test("rejects dirty or untracked Unity source", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  await writeFile(
    join(repositoryRoot, "unity", "three-bosses", "Assets", "Uncommitted.cs"),
    "public sealed class Uncommitted {}\n",
  );

  await assert.rejects(
    () => packageFixture({ repositoryRoot, externalBuildRoot }),
    /clean and committed/u,
  );
});

test("rejects ignored files inside Unity source roots", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  await writeFile(
    join(repositoryRoot, ".gitignore"),
    "unity/three-bosses/Assets/Ignored.cs\n",
  );
  await git(repositoryRoot, ["add", ".gitignore"]);
  await git(repositoryRoot, ["commit", "-m", "Ignore generated Unity source"]);
  await writeFile(
    join(repositoryRoot, "unity", "three-bosses", "Assets", "Ignored.cs"),
    "public sealed class Ignored {}\n",
  );

  await assert.rejects(
    () => packageFixture({ repositoryRoot, externalBuildRoot }),
    /ignored files/u,
  );
});

test("rejects a release marker for an earlier Unity source tree", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  await writeFile(
    join(repositoryRoot, "unity", "three-bosses", "Assets", "Game.cs"),
    "public sealed class UpdatedGame {}\n",
  );
  await git(repositoryRoot, ["add", "unity/three-bosses"]);
  await git(repositoryRoot, ["commit", "-m", "Update Three Bosses source"]);

  await assert.rejects(
    () => packageFixture({ repositoryRoot, externalBuildRoot }),
    /marker does not match the current committed Unity source/u,
  );
});

test("rejects a changed build after certification", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  await writeFile(join(externalBuildRoot, "Build", "game.data.br"), "changed\n");

  await assert.rejects(
    () => packageFixture({ repositoryRoot, externalBuildRoot }),
    /still being finalized/u,
  );
});

test("rejects unexpected and debug build files", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  await writeFile(join(externalBuildRoot, "Build", "game.symbols.json"), "{}\n");

  await assert.rejects(
    () => packageFixture({ repositoryRoot, externalBuildRoot }),
    /debug artifact/u,
  );
});

test("rejects URL-special characters in release input paths", async (t) => {
  for (const fileName of ["%2e%2e", "fragment#asset"]) {
    await t.test(fileName, async () => {
      const repositoryRoot = await createRepository();
      const externalBuildRoot = await createCertifiedBuild();
      await writeFile(join(externalBuildRoot, "Build", fileName), "unsafe\n");
      await assert.rejects(
        () => packageFixture({ repositoryRoot, externalBuildRoot }),
        /unsafe URL path/u,
      );
    });
  }
});

test("rejects unexpected external root files", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  await writeFile(join(externalBuildRoot, "unexpected.txt"), "unexpected\n");

  await assert.rejects(
    () => packageFixture({ repositoryRoot, externalBuildRoot }),
    /Unexpected file/u,
  );
});

test("rejects symlinks in StreamingAssets", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild({ streamingAssets: true });
  const outside = await mkdtemp(join(tmpdir(), "three-bosses-release-outside-"));
  temporaryRoots.push(outside);
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await symlink(
    outside,
    join(externalBuildRoot, "StreamingAssets", "escaped"),
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    () => packageFixture({ repositoryRoot, externalBuildRoot }),
    /symbolic link/u,
  );
});

test("rejects uncertified StreamingAssets files", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild({ streamingAssets: true });
  await assert.rejects(
    () => packageFixture({ repositoryRoot, externalBuildRoot }),
    /completion marker recursively certifies/u,
  );
});

test("rejects a linked public-directory ancestor", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild();
  const outside = await mkdtemp(join(tmpdir(), "three-bosses-public-outside-"));
  temporaryRoots.push(outside);
  await mkdir(join(repositoryRoot, "frontend"));
  await symlink(
    outside,
    join(repositoryRoot, "frontend", "public"),
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    () => packageFixture({ repositoryRoot, externalBuildRoot }),
    /linked, or non-directory ancestor/u,
  );
});

test("refuses to overwrite a corrupted immutable release", async () => {
  const repositoryRoot = await createRepository();
  const externalBuildRoot = await createCertifiedBuild({ streamingAssets: false });
  const packaged = await packageFixture({ repositoryRoot, externalBuildRoot });
  await writeFile(join(packaged.releasePath, "Build", "game.loader.js"), "corrupt\n");

  await assert.rejects(
    () => packageFixture({ repositoryRoot, externalBuildRoot }),
    /verification failed/u,
  );
});
