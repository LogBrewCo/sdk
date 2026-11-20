import {
  CDN_PREFIX,
  EXIT_BLOCKED,
  EXIT_USAGE,
  PROJECT_ID,
  assertExcludes,
  joinedErrors,
  jsPath,
  manifestArgs,
  mapPath,
  parseJson,
  pick,
  prepareBuild,
  runCli,
  succeeded,
  withBuild
} from "./release-artifacts-helpers.js";
import { rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
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

await test("manifest-js skips a file with no sourceMappingURL comment and no sibling map", async () => {
  await withBuild(async (build) => {
    await writeFile(path.join(build.buildDir, "assets", "polyfills.js"), "self.polyfilled=!0;\n", "utf8");
    await prepareBuild(build, true);
    const manifest = succeeded(await runCli(manifestArgs(build, ["--minified-path-prefix", CDN_PREFIX])));
    assert.deepEqual(
      {
        artifactCount: pick(manifest, "artifacts.length"),
        path: pick(manifest, "artifacts.0.minifiedSource.path"),
        skipped: pick(manifest, "skippedSources"),
        status: pick(manifest, "validation.status")
      },
      { artifactCount: 1, path: "assets/app.js", skipped: ["assets/polyfills.js"], status: "ready" }
    );
  });
});

await test("manifest-js blocks a file that names a missing or empty source map", async () => {
  await withBuild(async (build) => {
    const assets = path.join(build.buildDir, "assets");
    await prepareBuild(build, true);
    await writeFile(path.join(assets, "named.js"), "named();\n//# sourceMappingURL=named.js.map\n", "utf8");
    await writeFile(path.join(assets, "empty.js"), "empty();\n//# sourceMappingURL=empty.js.map\n", "utf8");
    await writeFile(path.join(assets, "empty.js.map"), "", "utf8");
    const result = await runCli(manifestArgs(build, ["--minified-path-prefix", CDN_PREFIX]));
    assert.equal(result.status, EXIT_BLOCKED);
    assert.equal(
      joinedErrors(parseJson(result.stdout)),
      "assets/empty.js: source map file is empty: assets/empty.js.map\nassets/named.js: source map file is missing: assets/named.js.map"
    );
  });
});

await test("manifest-js blocks a build where no file has a source map", async () => {
  await withBuild(async (build) => {
    await writeFile(jsPath(build), "app();\n", "utf8");
    await rm(mapPath(build));
    const result = await runCli(manifestArgs(build, ["--minified-path-prefix", CDN_PREFIX]));
    assert.equal(result.status, EXIT_BLOCKED);
    assert.match(joinedErrors(parseJson(result.stdout)), /no JavaScript file in the build directory has a source map/u);
  });
});
