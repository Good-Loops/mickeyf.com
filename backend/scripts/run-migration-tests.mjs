import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const REPOSITORY_DIRECTORY = resolve(BACKEND_DIRECTORY, "..");

const RUN_ID = `${process.pid}-${randomBytes(4).toString("hex")}`;
export const COMPOSE_PROJECT_NAME = `mickeyf-migration-test-${RUN_ID}`;
export const COMPOSE_FILE = resolve(
  REPOSITORY_DIRECTORY,
  "compose.migration-test.yaml",
);
export const MIGRATION_INTEGRATION_TEST_COMMAND = Object.freeze({
  executable: process.execPath,
  args: Object.freeze([
    "--test",
    "-r",
    "ts-node/register",
    "ts/migrations/leaderboardMigration.integration.test.ts",
  ]),
});
export const P4_VEGA_DUAL_WRITE_INTEGRATION_TEST_COMMAND = Object.freeze({
  executable: process.execPath,
  args: Object.freeze([
    "--test",
    "-r",
    "ts-node/register",
    "ts/leaderboards/p4VegaScoreRepository.integration.test.ts",
  ]),
});
export const P4_VEGA_BACKFILL_INTEGRATION_TEST_COMMAND = Object.freeze({
  executable: process.execPath,
  args: Object.freeze([
    "--test",
    "-r",
    "ts-node/register",
    "ts/migrations/p4VegaBackfill.integration.test.ts",
  ]),
});

const INTEGRATION_TEST_COMMANDS = Object.freeze([
  MIGRATION_INTEGRATION_TEST_COMMAND,
  P4_VEGA_DUAL_WRITE_INTEGRATION_TEST_COMMAND,
  P4_VEGA_BACKFILL_INTEGRATION_TEST_COMMAND,
]);

const MYSQL_SERVICE = "mysql";
const MYSQL_IMAGE =
  "mysql:8.0.31@sha256:3d7ae561cf6095f6aca8eb7830e1d14734227b1fb4748092f2be2cfbccf7d614";
const MYSQL_HOST = "127.0.0.1";
const MYSQL_DATABASE = "mickeyf_migration_test";
const MYSQL_USER = "migration_test";
const MYSQL_PASSWORD = "migration-test-only";
const MYSQL_ROOT_PASSWORD = "migration-test-root-only";

const composeEnvironment = Object.freeze({
  ...process.env,
  COMPOSE_DISABLE_ENV_FILE: "1",
});

const composeArgs = (...args) => [
  "compose",
  "--project-name",
  COMPOSE_PROJECT_NAME,
  "--file",
  COMPOSE_FILE,
  ...args,
];

const activeChildren = new Set();

const runProcess = (
  executable,
  args,
  { cwd = REPOSITORY_DIRECTORY, env = process.env, captureOutput = false } = {},
) => new Promise((resolvePromise, reject) => {
  const child = spawn(executable, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  activeChildren.add(child);

  const stdout = [];
  const stderr = [];
  if (captureOutput) {
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
  }

  child.once("error", (error) => {
    activeChildren.delete(child);
    reject(error);
  });
  child.once("close", (code, signal) => {
    activeChildren.delete(child);
    const output = Buffer.concat(stdout).toString("utf8");
    if (code === 0) {
      resolvePromise(output);
      return;
    }

    const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
    const termination = signal ? `signal ${signal}` : `code ${code}`;
    reject(new Error(
      diagnostic
        ? `${executable} exited with ${termination}: ${diagnostic}`
        : `${executable} exited with ${termination}.`,
    ));
  });
});

const runCompose = (args, options = {}) => runProcess(
  "docker",
  composeArgs(...args),
  {
    cwd: REPOSITORY_DIRECTORY,
    env: composeEnvironment,
    ...options,
  },
);

const getMigrationTestEnvironment = (mysqlPort) => {
  const environment = { ...process.env };

  // If a test accidentally falls back to the runtime application's database
  // variables, fail closed instead of touching a developer or Cloud SQL database.
  for (const key of [
    "DATABASE_URL",
    "DB_HOST",
    "DB_PORT",
    "DB_NAME",
    "DB_USER",
    "DB_PASS",
    "CLOUD_SQL_CONNECTION_NAME",
  ]) {
    delete environment[key];
  }

  return {
    ...environment,
    NODE_ENV: "test",
    MIGRATION_TEST_ENABLED: "1",
    MIGRATION_TEST_HOST: MYSQL_HOST,
    MIGRATION_TEST_PORT: mysqlPort,
    MIGRATION_TEST_DATABASE: MYSQL_DATABASE,
    MIGRATION_TEST_USER: MYSQL_USER,
    MIGRATION_TEST_PASSWORD: MYSQL_PASSWORD,
    MIGRATION_TEST_ROOT_USER: "root",
    MIGRATION_TEST_ROOT_PASSWORD: MYSQL_ROOT_PASSWORD,
    MIGRATION_DB_HOST: MYSQL_HOST,
    MIGRATION_DB_PORT: mysqlPort,
    MIGRATION_DB_NAME: MYSQL_DATABASE,
    MIGRATION_DB_USER: MYSQL_USER,
    MIGRATION_DB_PASSWORD: MYSQL_PASSWORD,
    MIGRATION_DB_PASS: MYSQL_PASSWORD,
    MIGRATION_CONFIRM_DATABASE: MYSQL_DATABASE,
    MIGRATION_CONFIRM_TARGET: `${MYSQL_HOST}:${mysqlPort}/${MYSQL_DATABASE}`,
    MIGRATION_ALLOW_APPLY: "1",
    MIGRATION_ALLOW_ROLLBACK_EMPTY: "1",
    MIGRATION_ALLOW_P4_VEGA_BACKFILL: "1",
    MIGRATION_ALLOW_P4_VEGA_RECONCILE: "1",
  };
};

const inspectMigrationContainer = async () => {
  const containerIdOutput = await runCompose(
    ["ps", "--quiet", MYSQL_SERVICE],
    { captureOutput: true },
  );
  const containerIds = containerIdOutput
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);

  if (containerIds.length !== 1 || !/^[a-f0-9]{12,64}$/iu.test(containerIds[0])) {
    throw new Error(
      `Expected exactly one ${COMPOSE_PROJECT_NAME} MySQL container; found ${containerIds.length}.`,
    );
  }

  const inspectionOutput = await runProcess(
    "docker",
    ["inspect", "--type", "container", containerIds[0]],
    { cwd: REPOSITORY_DIRECTORY, captureOutput: true },
  );
  const inspections = JSON.parse(inspectionOutput);
  if (!Array.isArray(inspections) || inspections.length !== 1) {
    throw new Error("Docker returned an unexpected migration-test inspection result.");
  }

  const [container] = inspections;
  const labels = container.Config?.Labels ?? {};
  const publishedPorts = container.NetworkSettings?.Ports?.["3306/tcp"];
  const isExpectedContainer =
    labels["com.docker.compose.project"] === COMPOSE_PROJECT_NAME
    && labels["com.docker.compose.service"] === MYSQL_SERVICE
    && labels["com.mickeyf.purpose"] === "migration-test"
    && labels["com.mickeyf.scope"] === "local-test-only"
    && container.Config?.Image === MYSQL_IMAGE
    && container.State?.Running === true
    && container.State?.Health?.Status === "healthy";
  const isExpectedPort =
    Array.isArray(publishedPorts)
    && publishedPorts.length === 1
    && publishedPorts[0]?.HostIp === MYSQL_HOST
    && /^[0-9]{1,5}$/u.test(publishedPorts[0]?.HostPort ?? "")
    && Number(publishedPorts[0]?.HostPort) >= 1
    && Number(publishedPorts[0]?.HostPort) <= 65535
    && publishedPorts[0]?.HostPort !== "3306";

  if (!isExpectedContainer || !isExpectedPort) {
    throw new Error(
      "Refusing to run migration tests because the container identity or published port did not match the isolated test configuration.",
    );
  }

  const mysqlPort = publishedPorts[0].HostPort;
  console.log(
    `Verified isolated MySQL ${containerIds[0].slice(0, 12)} on ${MYSQL_HOST}:${mysqlPort}.`,
  );
  return mysqlPort;
};

let cleanupPromise;
const cleanup = () => {
  if (!cleanupPromise) {
    cleanupPromise = runCompose([
      "down",
      "--volumes",
      "--remove-orphans",
      "--timeout",
      "30",
    ]).finally(() => {
      cleanupPromise = undefined;
    });
  }
  return cleanupPromise;
};

export const runMigrationTests = async () => {
  let failure;

  try {
    await runProcess("docker", ["compose", "version"], {
      cwd: REPOSITORY_DIRECTORY,
      env: composeEnvironment,
    });
    await runCompose([
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "90",
      MYSQL_SERVICE,
    ]);
    const mysqlPort = await inspectMigrationContainer();
    for (const command of INTEGRATION_TEST_COMMANDS) {
      await runProcess(
        command.executable,
        command.args,
        {
          cwd: BACKEND_DIRECTORY,
          env: getMigrationTestEnvironment(mysqlPort),
        },
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      if (failure) {
        console.error(`Migration-test cleanup also failed: ${cleanupError.message}`);
      } else {
        failure = cleanupError;
      }
    }
  }

  if (failure) throw failure;
};

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  let shuttingDown = false;
  const handleSignal = async (exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!cleanupPromise) {
      for (const child of activeChildren) child.kill();
    }
    try {
      await cleanup();
    } catch (error) {
      console.error(`Migration-test signal cleanup failed: ${error.message}`);
    } finally {
      process.exit(exitCode);
    }
  };
  const handleInterrupt = () => void handleSignal(130);
  const handleTermination = () => void handleSignal(143);
  process.once("SIGINT", handleInterrupt);
  process.once("SIGTERM", handleTermination);

  runMigrationTests()
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(() => {
      process.removeListener("SIGINT", handleInterrupt);
      process.removeListener("SIGTERM", handleTermination);
    });
}
