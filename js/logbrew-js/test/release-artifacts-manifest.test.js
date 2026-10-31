import {
  CDN_PREFIX,
  EXIT_BLOCKED,
  EXIT_USAGE,
  PROJECT_ID,
  assertExcludes,
  joinedErrors,
  manifestArgs,
  parseJson,
  pick,
  prepareBuild,
  runCli,
  succeeded,
  withBuild
} from "./release-artifacts-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

const SHA256_RE = /^[0-9a-f]{64}$/u;

/**
 * @param {unknown} manifest
 * @returns {void}
 */
function assertReadyManifest(manifest) {
  const artifact = pick(manifest, "artifacts.0");
  assert.deepEqual(
    {
      debugIdFromMap: pick(artifact, "sourceMap.debugId"),
      hasSourcesContent: pick(artifact, "sourceMap.hasSourcesContent"),
      minifiedPathPrefix: pick(manifest, "minifiedPathPrefix"),
      minifiedUrl: pick(artifact, "minifiedSource.minifiedUrl"),
      projectId: pick(manifest, "projectId"),
      sourceCount: pick(artifact, "sourceMap.sourceCount"),
      status: pick(manifest, "validation.status")
    },
    {
      debugIdFromMap: pick(artifact, "debugId"),
      hasSourcesContent: false,
      minifiedPathPrefix: CDN_PREFIX,
      minifiedUrl: `${CDN_PREFIX}/assets/app.js`,
      projectId: PROJECT_ID,
      sourceCount: 1,
      status: "ready"
    }
  );
  assert.equal(pick(artifact, "debugId"), pick(artifact, "minifiedSource.debugId"));
  assert.match(String(pick(artifact, "minifiedSource.artifactSha256")), SHA256_RE);
  assert.match(String(pick(artifact, "sourceMap.artifactSha256")), SHA256_RE);
}

await test("manifest-js emits a ready privacy-bounded source-map manifest", async () => {
  await withBuild(async (build) => {
    await prepareBuild(build, true);
    const result = await runCli(manifestArgs(build, [
      "--project-id",
      PROJECT_ID,
      "--minified-path-prefix",
      `${CDN_PREFIX}?flag=debug#fragment`,
      "--repository-url",
      "https://github.com/example/checkout-web",
      "--commit-sha",
      "abc123"
    ]));
    assertReadyManifest(succeeded(result));
    assertExcludes(result.stdout, ["source-fixture-marker", "flag=debug", "#fragment"]);
  });
});

await test("manifest-js rejects a non-UUID project id", async () => {
  await withBuild(async (build) => {
    const result = await runCli(manifestArgs(build, ["--project-id", "project-not-a-uuid", "--minified-path-prefix", CDN_PREFIX]));
    assert.equal(result.status, EXIT_USAGE);
    assert.match(result.stderr, /--project-id must be a UUID/u);
  });
});

await test("manifest-js blocks embedded sourcesContent until the build is stripped", async () => {
  await withBuild(async (build) => {
    const result = await runCli(manifestArgs(build, ["--minified-path-prefix", CDN_PREFIX]));
    assert.equal(result.status, EXIT_BLOCKED);
    const manifest = parseJson(result.stdout);
    assert.equal(pick(manifest, "validation.status"), "blocked");
    assert.match(joinedErrors(manifest), /source map contains sourcesContent/u);
  });
});
