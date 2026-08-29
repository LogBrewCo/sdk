import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = dirname(testDirectory);
const scopeDirectory = join(packageDirectory, "node_modules", "@logbrew");
const sdkLink = join(scopeDirectory, "sdk");
const createdLink = !existsSync(sdkLink) && !existsSync(join(packageDirectory, "..", "sdk"));

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
    rmSync(sdkLink, { force: true });
    try {
      rmdirSync(scopeDirectory);
      rmdirSync(dirname(scopeDirectory));
    } catch {}
  }
}

function sourceEntries() {
  return [packageDirectory, join(packageDirectory, "examples")].flatMap((directory) => (
    readdirSync(directory)
      .filter((name) => /\.(?:c?js|mjs)$/u.test(name))
      .map((name) => join(directory, name))
  ));
}
