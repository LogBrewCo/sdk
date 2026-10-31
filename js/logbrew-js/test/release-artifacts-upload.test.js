import {
  EXIT_VALIDATION_FAILED,
  HOSTED_ENDPOINT,
  PROJECT_ID,
  assertExcludes,
  joinedErrors,
  parseJson,
  pick,
  prepareBuild,
  runCli,
  succeeded,
  withBuild,
  writeManifest
} from "./release-artifacts-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { Build, CliResult } from "./release-artifacts-helpers.js"
 */

/**
 * @param {Build} build
 * @param {readonly string[]} manifestExtra
 * @param {string} endpoint
 * @returns {Promise<CliResult>}
 */
async function uploadDryRun(build, manifestExtra, endpoint) {
  await prepareBuild(build, true);
  const { manifestPath } = await writeManifest(build, manifestExtra);
  const hosted = endpoint.startsWith("https:") ? ["--allow-hosted"] : [];
  return runCli(["upload-js", "--build-dir", build.buildDir, "--manifest", manifestPath, "--endpoint", endpoint, ...hosted, "--dry-run"]);
}

/**
 * @param {unknown} report
 * @returns {Readonly<Record<string, unknown>>}
 */
function dryRunSummary(report) {
  return {
    artifactCount: pick(report, "artifactCount"),
    attempts: pick(report, "attempts"),
    endpoint: pick(report, "endpoint"),
    filePartCount: pick(report, "filePartCount"),
    status: pick(report, "status")
  };
}

await test("upload-js validates a ready manifest and prints a dry-run upload plan", async () => {
  await withBuild(async (build) => {
    const result = await uploadDryRun(build, [], "http://127.0.0.1:4319/upload?marker=placeholder#ignored");
    assert.deepEqual(dryRunSummary(succeeded(result)), {
      artifactCount: 1,
      attempts: [],
      endpoint: "http://127.0.0.1:4319/upload",
      filePartCount: 2,
      status: "dry_run"
    });
    assertExcludes(result.stdout, ["source-fixture-marker", "marker=placeholder", "#ignored", build.root]);
  });
});

await test("upload-js allows an explicit hosted HTTPS dry-run without query or auth leakage", async () => {
  await withBuild(async (build) => {
    const result = await uploadDryRun(build, ["--project-id", PROJECT_ID], HOSTED_ENDPOINT);
    assert.deepEqual(dryRunSummary(succeeded(result)), {
      artifactCount: 1,
      attempts: [],
      endpoint: HOSTED_ENDPOINT,
      filePartCount: 2,
      status: "dry_run"
    });
    assertExcludes(result.stdout, ["source-fixture-marker", "release-artifact-auth", build.root]);
  });
});

await test("upload-js rejects hosted manifests without a valid project id", async () => {
  await withBuild(async (build) => {
    const result = await uploadDryRun(build, [], HOSTED_ENDPOINT);
    assert.equal(result.status, EXIT_VALIDATION_FAILED);
    const report = parseJson(result.stdout);
    assert.equal(pick(report, "status"), "validation_failed");
    assert.deepEqual(pick(report, "validation.errors"), ["hosted release artifact uploads require manifest projectId as a UUID"]);
  });
});

await test("upload-js rejects unsafe hosted endpoints even with hosted upload opt-in", async () => {
  await withBuild(async (build) => {
    const result = await uploadDryRun(build, [], ["https://api", "logbrew", "com/api/release-artifacts"].join("."));
    assert.equal(result.status, EXIT_VALIDATION_FAILED);
    const report = parseJson(result.stdout);
    assert.equal(pick(report, "status"), "validation_failed");
    assert.match(joinedErrors(report), /must use https:\/\/api\.logbrew\.co/u);
    assertExcludes(result.stdout, ["api.logbrew.com"]);
  });
});
