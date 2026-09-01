import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import {
  isThreeBossesRuntimeUrl,
  parseThreeBossesSmokeArguments,
  smokeThreeBossesWebGlPreview,
} from "./smoke-three-bosses-webgl-preview.mjs";

const roots = [];
const trustedChromePaths = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "/opt/google/chrome/google-chrome",
  win32: join(homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
};
const trustedChromePath = trustedChromePaths[platform()];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true,
  })));
});

const createFakeChromium = ({
  dom = {
    canvasConnected: true,
    canvasHeight: 540,
    canvasWidth: 960,
    state: "running",
  },
  onGoto,
  onLaunch,
  state = "running",
  waitError,
} = {}) => {
  const page = new EventEmitter();
  page.goto = async () => {
    onGoto?.(page);
    return { status: () => 200 };
  };
  page.waitForFunction = async () => {
    if (waitError) throw waitError;
    return {
      dispose: async () => {},
      jsonValue: async () => state,
    };
  };
  page.evaluate = async () => dom;
  page.screenshot = async ({ path }) => writeFile(path, "fake png");
  const context = {
    close: async () => {},
    newPage: async () => page,
  };
  const browser = {
    close: async () => {},
    newContext: async () => context,
  };
  return {
    launch: async (options) => {
      onLaunch?.(options);
      return browser;
    },
  };
};

const runSmoke = async (overrides = {}) => {
  const artifactDirectory = await mkdtemp(join(tmpdir(), "three-bosses-smoke-"));
  roots.push(artifactDirectory);
  return smokeThreeBossesWebGlPreview({
    artifactDirectory,
    baseUrl: "https://preview.example/",
    chromeExecutable: "/caller-supplied/chrome",
    chromiumLauncher: createFakeChromium(overrides),
    timeoutMs: 100,
  });
};

test("parses explicit CLI values and environment fallbacks", () => {
  const fromEnvironment = parseThreeBossesSmokeArguments([], {
    BASE_URL: "https://preview.example",
    CHROME_EXECUTABLE: trustedChromePath,
    THREE_BOSSES_SMOKE_ARTIFACTS: "artifacts/smoke",
  });
  assert.equal(fromEnvironment.baseUrl, "https://preview.example/");
  assert.equal(fromEnvironment.chromeExecutable, resolve(trustedChromePath));
  assert.match(fromEnvironment.artifactDirectory, /artifacts[\\/]smoke$/u);

  const fromCli = parseThreeBossesSmokeArguments([
    "--base-url", "http://127.0.0.1:5000",
    "--chrome-executable", trustedChromePath,
    "--artifacts", "output",
  ], {});
  assert.equal(fromCli.baseUrl, "http://127.0.0.1:5000/");
  assert.equal(fromCli.chromeExecutable, resolve(trustedChromePath));
  assert.match(fromCli.artifactDirectory, /output$/u);
});

test("rejects an arbitrary Chrome executable path", () => {
  assert.throws(
    () => parseThreeBossesSmokeArguments([
      "--base-url", "https://preview.example",
      "--chrome-executable", "/tmp/caller-controlled/chrome",
    ], {}),
    /approved system installation/u,
  );
});

test("matches only Three Bosses Unity runtime requests", () => {
  assert.equal(
    isThreeBossesRuntimeUrl("https://preview.example/unity/three-bosses/releases/a/game.wasm.br"),
    true,
  );
  assert.equal(
    isThreeBossesRuntimeUrl("https://preview.example/games/three-bosses"),
    false,
  );
  assert.equal(isThreeBossesRuntimeUrl("not a URL"), false);
});

test("passes only after running with a connected intrinsic canvas", async () => {
  assert.deepEqual(await runSmoke(), {
    canvasConnected: true,
    canvasHeight: 540,
    canvasWidth: 960,
    state: "running",
  });
});

test("uses the explicit headless SwiftShader WebGL path", async () => {
  let launchOptions;
  await runSmoke({ onLaunch: (options) => { launchOptions = options; } });
  assert.equal(launchOptions.headless, true);
  assert.deepEqual(launchOptions.args, [
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--use-gl=angle",
    "--use-angle=swiftshader-webgl",
    "--enable-unsafe-swiftshader",
  ]);
});

test("ignores unrelated failed requests", async () => {
  const result = await runSmoke({
    onGoto: (page) => page.emit("response", {
      request: () => ({ method: () => "GET" }),
      status: () => 404,
      url: () => "https://preview.example/favicon.ico",
    }),
  });
  assert.equal(result.state, "running");
});

test("fails a Unity asset response and writes screenshot plus diagnostics", async () => {
  let rejection;
  try {
    await runSmoke({
      onGoto: (page) => page.emit("response", {
        request: () => ({ method: () => "GET" }),
        status: () => 503,
        url: () => "https://preview.example/unity/three-bosses/releases/a/game.data.br",
      }),
    });
  } catch (error) {
    rejection = error;
  }
  assert.match(rejection.message, /runtime asset failed/u);
  assert.equal(await readFile(rejection.artifacts.screenshotPath, "utf8"), "fake png");
  const diagnostics = JSON.parse(await readFile(
    rejection.artifacts.diagnosticsPath,
    "utf8",
  ));
  assert.equal(diagnostics.unityAssetFailures[0].status, 503);
  assert.match(diagnostics.failure.message, /runtime asset failed/u);
});

test("fails a Unity request transport error", async () => {
  await assert.rejects(
    () => runSmoke({
      onGoto: (page) => page.emit("requestfailed", {
        failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }),
        method: () => "GET",
        url: () => "https://preview.example/unity/three-bosses/releases/a/game.wasm.br",
      }),
    }),
    /runtime asset failed/u,
  );
});

test("fails an uncaught page error", async () => {
  await assert.rejects(
    () => runSmoke({
      onGoto: (page) => page.emit("pageerror", new Error("Unity loader exploded")),
    }),
    /page error: Unity loader exploded/u,
  );
});

test("dismisses and fails an unexpected Unity startup dialog", async () => {
  let dismissed = false;
  await assert.rejects(
    () => runSmoke({
      onGoto: (page) => page.emit("dialog", {
        dismiss: async () => { dismissed = true; },
        message: () => "Unable to initialize the player",
        type: () => "alert",
      }),
    }),
    /opened a startup dialog/u,
  );
  assert.equal(dismissed, true);
});

test("fails the page error state and an invalid intrinsic canvas", async () => {
  await assert.rejects(
    () => runSmoke({ state: "error" }),
    /entered its WebGL error state/u,
  );
  await assert.rejects(
    () => runSmoke({
      dom: {
        canvasConnected: true,
        canvasHeight: 0,
        canvasWidth: 960,
        state: "running",
      },
    }),
    /without a valid Unity canvas/u,
  );
});

test("fails a startup timeout", async () => {
  await assert.rejects(
    () => runSmoke({ waitError: new Error("Timeout 100ms exceeded") }),
    /Timeout 100ms exceeded/u,
  );
});
