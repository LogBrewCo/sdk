import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = dirname(testDirectory);
const scopeDirectory = join(packageDirectory, "node_modules", "@logbrew");
const sdkLink = join(scopeDirectory, "sdk");
const require = createRequire(import.meta.url);
const sdkIsInstalled = canResolveSdk();
const createdLink = !sdkIsInstalled && !existsSync(sdkLink);

try {
  if (createdLink) {
    const sdkSource = realpathSync(join(packageDirectory, "..", "logbrew-js"));
    mkdirSync(scopeDirectory, { recursive: true });
    symlinkSync(sdkSource, sdkLink, "dir");
  }
  const result = spawnSync(
    process.execPath,
    ["--test", ...process.argv.slice(2), "persistent-delivery.test.js"],
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

function canResolveSdk() {
  try {
    require.resolve("@logbrew/sdk");
    return true;
  } catch {
    return false;
  }
}

function removeIfEmpty(path) {
  try {
    rmdirSync(path);
  } catch {
    // Preserve directories containing files not owned by this test runner.
  }
}
