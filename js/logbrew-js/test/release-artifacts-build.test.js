import { mkdtemp, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * @typedef {(cliPath: string, command: string, args: readonly string[]) => unknown} ReleaseArtifactCliRunner
 */

const BUILD_HELPER_PATH = fileURLToPath(new URL("../release-artifacts-build.cjs", import.meta.url));
const MAX_MESSAGE_LENGTH = 260;
const LONG_VALUE_LENGTH = 300;
const requireFromTest = createRequire(import.meta.url);

/**
 * @param {unknown} value
 * @returns {value is { readonly runReleaseArtifactCli: ReleaseArtifactCliRunner }}
 */
function hasCliRunner(value) {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "runReleaseArtifactCli") === "function";
}

/**
 * @returns {ReleaseArtifactCliRunner}
 */
function loadCliRunner() {
  /** @type {unknown} */
  const helper = requireFromTest(BUILD_HELPER_PATH);
  assert.ok(hasCliRunner(helper));
  return helper.runReleaseArtifactCli;
}

/**
 * @param {string} root
 * @returns {Promise<string>}
 */
async function writeFakeCli(root) {
  const fakeCli = path.join(root, "fake-release-artifacts.cjs");
  const report = { status: "validation_failed", validation: { errors: [`invalid\nvalue ${"x".repeat(LONG_VALUE_LENGTH)} tail-marker`] } };
  await writeFile(fakeCli, `process.stdout.write(${JSON.stringify(JSON.stringify(report))});\nprocess.exit(4);\n`, "utf8");
  return fakeCli;
}

await test("build-time release-artifact failures bound validation diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logbrew-release-artifact-build-error-"));
  try {
    const fakeCli = await writeFakeCli(root);
    const runReleaseArtifactCli = loadCliRunner();
    assert.throws(() => runReleaseArtifactCli(fakeCli, "upload-js", []), (thrown) => {
      assert.ok(thrown instanceof Error);
      assert.match(thrown.message, /upload-js failed: invalid value/u);
      assert.doesNotMatch(thrown.message, /[\r\n]/u);
      assert.equal(thrown.message.includes("tail-marker"), false);
      assert.ok(thrown.message.length <= MAX_MESSAGE_LENGTH);
      return true;
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
