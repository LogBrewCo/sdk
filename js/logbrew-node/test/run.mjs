import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
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
const sdkSource = realpathSync(join(packageDirectory, "..", "logbrew-js"));
const createdLink = !existsSync(sdkLink);

try {
  if (createdLink) {
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

function removeIfEmpty(path) {
  try {
    rmdirSync(path);
  } catch {
    // Preserve directories containing files not owned by this test runner.
  }
}
