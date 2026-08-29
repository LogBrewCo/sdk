import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = dirname(testDirectory);
const scopeDirectory = join(packageDirectory, "node_modules", "@logbrew");
const sdkLink = join(scopeDirectory, "sdk");
const createdLink = !existsSync(sdkLink);

try {
  if (createdLink) {
    const sdkSource = realpathSync(join(packageDirectory, "..", "logbrew-js"));
    mkdirSync(scopeDirectory, { recursive: true });
    symlinkSync(sdkSource, sdkLink, "dir");
  }
  const build = await Bun.build({
    entrypoints: sourceEntries(),
    naming: "[dir]/[name]-[hash].[ext]",
    packages: "external",
    target: "node",
    write: false
  });
  if (!build.success) {
    throw new AggregateError(build.logs, "Node package source build failed");
  }
  const result = spawnSync(
    process.execPath,
    [
      "test",
      ...process.argv.slice(2),
      "persistent-delivery.test.js",
      "pino-instrumentation.test.js",
      "request-tracing.test.js",
      "runtime-context.test.js"
    ],
    {
    cwd: testDirectory,
    stdio: "inherit"
    }
  );
  process.exitCode = result.status ?? 1;
} finally {
  if (createdLink) {
    unlinkSync(sdkLink);
    removeIfEmpty(scopeDirectory);
    removeIfEmpty(dirname(scopeDirectory));
  }
}

function sourceEntries() {
  return [packageDirectory, join(packageDirectory, "examples")].flatMap((directory) => (
    readdirSync(directory)
      .filter((name) => /\.(?:c?js|mjs)$/u.test(name))
      .map((name) => join(directory, name))
  ));
}

function removeIfEmpty(path) {
  try {
    rmdirSync(path);
  } catch {
    // Preserve directories containing files not owned by this test runner.
  }
}
