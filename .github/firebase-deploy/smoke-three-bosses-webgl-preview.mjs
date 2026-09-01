import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pagePath = "/games/three-bosses";
const runtimePathPrefix = "/unity/three-bosses/";
const defaultArtifactDirectory = resolve(
  "node_modules",
  ".cache",
  "three-bosses-webgl-smoke",
);
const defaultTimeoutMs = 120_000;
const chromeExecutablePathsByPlatform = Object.freeze({
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: [
    "/opt/google/chrome/chrome",
    "/opt/google/chrome/google-chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    join(homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
  ],
});
const trustedChromeExecutablePaths = Object.freeze(
  (chromeExecutablePathsByPlatform[platform()] ?? []).map((path) => resolve(path)),
);

export const resolveTrustedChromeExecutable = (chromeExecutable) => {
  const resolvedExecutable = resolve(chromeExecutable);
  if (!trustedChromeExecutablePaths.includes(resolvedExecutable)) {
    throw new Error("Three Bosses smoke Chrome must use an approved system installation.");
  }
  return resolvedExecutable;
};

const sanitizeUrl = (value) => {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "unavailable";
  }
};

const describeError = (error) => error instanceof Error
  ? { message: error.message, stack: error.stack }
  : { message: String(error) };

export const isThreeBossesRuntimeUrl = (value) => {
  try {
    return new URL(value).pathname.startsWith(runtimePathPrefix);
  } catch {
    return false;
  }
};

export const parseThreeBossesSmokeArguments = (
  args,
  environment = process.env,
) => {
  let baseUrl = environment.BASE_URL;
  let chromeExecutable = environment.CHROME_EXECUTABLE;
  let artifactDirectory = environment.THREE_BOSSES_SMOKE_ARTIFACTS
    ?? defaultArtifactDirectory;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (!["--base-url", "--chrome-executable", "--artifacts"].includes(argument)) {
      throw new Error(`Unknown Three Bosses smoke argument: ${argument}.`);
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${argument} requires a value.`);
    }
    index += 1;
    if (argument === "--base-url") baseUrl = value;
    if (argument === "--chrome-executable") chromeExecutable = value;
    if (argument === "--artifacts") artifactDirectory = value;
  }

  if (!baseUrl) throw new Error("--base-url or BASE_URL is required.");
  const parsedBaseUrl = new URL(baseUrl);
  if (!["http:", "https:"].includes(parsedBaseUrl.protocol)) {
    throw new Error("Three Bosses smoke base URL must use HTTP or HTTPS.");
  }
  if (!chromeExecutable) {
    throw new Error("--chrome-executable or CHROME_EXECUTABLE is required.");
  }

  return {
    artifactDirectory: resolve(artifactDirectory),
    baseUrl: parsedBaseUrl.href,
    chromeExecutable: resolveTrustedChromeExecutable(chromeExecutable),
  };
};

const createFatalSignal = () => {
  let resolveFatal;
  const promise = new Promise((resolvePromise) => {
    resolveFatal = resolvePromise;
  });
  return { promise, resolve: resolveFatal };
};

const captureFailureArtifacts = async ({ diagnostics, page, artifactDirectory }) => {
  await mkdir(artifactDirectory, { recursive: true });
  const screenshotPath = resolve(artifactDirectory, "three-bosses-webgl-smoke-failure.png");
  if (page) {
    try {
      await page.screenshot({ fullPage: true, path: screenshotPath });
      diagnostics.screenshot = screenshotPath;
    } catch (error) {
      diagnostics.screenshotError = describeError(error);
    }
  } else {
    diagnostics.screenshotError = {
      message: "No browser page was available for a failure screenshot.",
    };
  }
  const diagnosticsPath = resolve(
    artifactDirectory,
    "three-bosses-webgl-smoke-diagnostics.json",
  );
  await writeFile(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
  return {
    diagnosticsPath,
    screenshotPath: diagnostics.screenshot ?? null,
  };
};

const readStartupDom = () => {
  const wrapper = document.querySelector(".three-bosses__canvas-wrapper");
  const canvas = document.querySelector("#three-bosses-unity-canvas");
  return {
    canvasConnected: canvas instanceof HTMLCanvasElement && canvas.isConnected,
    canvasHeight: canvas instanceof HTMLCanvasElement ? canvas.height : 0,
    canvasWidth: canvas instanceof HTMLCanvasElement ? canvas.width : 0,
    state: wrapper?.getAttribute("data-three-bosses-state") ?? null,
  };
};

export const smokeThreeBossesWebGlPreview = async ({
  artifactDirectory = defaultArtifactDirectory,
  baseUrl,
  chromeExecutable,
  chromiumLauncher,
  timeoutMs = defaultTimeoutMs,
}) => {
  const targetUrl = new URL(pagePath, baseUrl).href;
  const diagnostics = {
    canvas: null,
    console: [],
    dialogs: [],
    failure: null,
    pageErrors: [],
    targetUrl: sanitizeUrl(targetUrl),
    unityAssetFailures: [],
  };
  const fatalSignal = createFatalSignal();
  let browser;
  let context;
  let page;

  try {
    browser = await chromiumLauncher.launch({
      args: [
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        "--use-gl=angle",
        "--use-angle=swiftshader-webgl",
        "--enable-unsafe-swiftshader",
      ],
      executablePath: chromeExecutable,
      headless: true,
    });
    context = await browser.newContext();
    page = await context.newPage();

    page.on("console", (message) => {
      diagnostics.console.push({
        location: message.location(),
        text: message.text(),
        type: message.type(),
      });
    });
    page.on("pageerror", (error) => {
      const entry = describeError(error);
      diagnostics.pageErrors.push(entry);
      fatalSignal.resolve({ kind: "pageerror", entry });
    });
    page.on("dialog", async (dialog) => {
      const entry = {
        message: dialog.message(),
        type: dialog.type(),
      };
      diagnostics.dialogs.push(entry);
      try {
        await dialog.dismiss();
      } catch (error) {
        entry.dismissError = describeError(error);
      }
      fatalSignal.resolve({ kind: "dialog", entry });
    });
    page.on("requestfailed", (request) => {
      if (!isThreeBossesRuntimeUrl(request.url())) return;
      const entry = {
        error: request.failure()?.errorText ?? "unknown request failure",
        method: request.method(),
        url: sanitizeUrl(request.url()),
      };
      diagnostics.unityAssetFailures.push(entry);
      fatalSignal.resolve({ kind: "asset", entry });
    });
    page.on("response", (response) => {
      const status = response.status();
      if ((status >= 200 && status < 300)
          || !isThreeBossesRuntimeUrl(response.url())) return;
      const entry = {
        method: response.request().method(),
        status,
        url: sanitizeUrl(response.url()),
      };
      diagnostics.unityAssetFailures.push(entry);
      fatalSignal.resolve({ kind: "asset", entry });
    });

    const navigation = await page.goto(targetUrl, {
      timeout: Math.min(timeoutMs, 30_000),
      waitUntil: "domcontentloaded",
    });
    const navigationStatus = navigation?.status();
    if (!navigation || navigationStatus < 200 || navigationStatus >= 300) {
      throw new Error(`Three Bosses route returned HTTP ${navigationStatus ?? "unknown"}.`);
    }

    const stateWait = page.waitForFunction(
      () => {
        const state = document
          .querySelector(".three-bosses__canvas-wrapper")
          ?.getAttribute("data-three-bosses-state");
        return state === "running" || state === "error" ? state : false;
      },
      undefined,
      { timeout: timeoutMs },
    ).then(async (handle) => {
      try {
        return { kind: "state", state: await handle.jsonValue() };
      } finally {
        await handle.dispose();
      }
    });

    const outcome = await Promise.race([fatalSignal.promise, stateWait]);
    if (outcome.kind === "pageerror") {
      throw new Error(`Three Bosses page error: ${outcome.entry.message}`);
    }
    if (outcome.kind === "dialog") {
      throw new Error(`Three Bosses opened a startup dialog: ${outcome.entry.message}`);
    }
    if (outcome.kind === "asset") {
      throw new Error("Three Bosses Unity runtime asset failed to load.");
    }
    if (outcome.state === "error") {
      throw new Error("Three Bosses entered its WebGL error state.");
    }

    diagnostics.canvas = await page.evaluate(readStartupDom);
    if (diagnostics.canvas.state !== "running"
        || !diagnostics.canvas.canvasConnected
        || diagnostics.canvas.canvasWidth <= 0
        || diagnostics.canvas.canvasHeight <= 0) {
      throw new Error("Three Bosses reached running without a valid Unity canvas.");
    }
    if (diagnostics.pageErrors.length > 0 || diagnostics.unityAssetFailures.length > 0) {
      throw new Error("Three Bosses emitted a fatal startup error.");
    }

    return diagnostics.canvas;
  } catch (error) {
    diagnostics.failure = describeError(error);
    const artifacts = await captureFailureArtifacts({
      artifactDirectory,
      diagnostics,
      page,
    });
    const failure = new Error(
      `${diagnostics.failure.message} Diagnostics: ${artifacts.diagnosticsPath}`,
      { cause: error },
    );
    failure.artifacts = artifacts;
    throw failure;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
};

const loadPlaywrightChromium = async () => {
  try {
    return (await import("playwright-core")).chromium;
  } catch (error) {
    throw new Error(
      "playwright-core must be installed; this smoke gate never downloads a browser.",
      { cause: error },
    );
  }
};

export const runThreeBossesWebGlSmokeCli = async ({
  args = process.argv.slice(2),
  environment = process.env,
} = {}) => {
  const options = parseThreeBossesSmokeArguments(args, environment);
  await access(options.chromeExecutable);
  return smokeThreeBossesWebGlPreview({
    ...options,
    chromiumLauncher: await loadPlaywrightChromium(),
  });
};

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const result = await runThreeBossesWebGlSmokeCli();
    console.log(
      `Three Bosses WebGL started (${result.canvasWidth}x${result.canvasHeight}).`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
