import {
  CDN_PREFIX,
  HOSTED_ENDPOINT,
  PROJECT_ID,
  assertExcludes,
  jsPath,
  mapPath,
  pick,
  readJson,
  readText,
  withBuild
} from "./release-artifacts-helpers.js";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { createLogBrewViteReleaseArtifactsPlugin } from "@logbrew/sdk/vite-release-artifacts";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

/**
 * @import { Build } from "./release-artifacts-helpers.js"
 * @import { LogBrewViteReleaseArtifactsPlugin, LogBrewViteReleaseArtifactUploadOptions } from "@logbrew/sdk/vite-release-artifacts"
 */

const IDENTITY = { environment: "production", release: "web@1.2.3", service: "checkout-web" };
const HOSTED_DRY_RUN = { allowHostedUpload: true, dryRun: true, endpoint: HOSTED_ENDPOINT };

/**
 * @param {LogBrewViteReleaseArtifactUploadOptions} upload
 * @returns {() => LogBrewViteReleaseArtifactsPlugin}
 */
function pluginWithUpload(upload) {
  return () => createLogBrewViteReleaseArtifactsPlugin({ ...IDENTITY, minifiedPathPrefix: CDN_PREFIX, projectId: PROJECT_ID, upload });
}

/**
 * @param {LogBrewViteReleaseArtifactsPlugin} plugin
 * @param {Build} build
 * @returns {Promise<void>}
 */
async function assertConfigChanges(plugin, build) {
  assert.deepEqual(plugin.config({ build: {} }), { build: { sourcemap: "hidden" }, esbuild: { keepNames: true } });
  assert.equal(plugin.config({ build: { sourcemap: true }, esbuild: { keepNames: false } }), null);
  const vitePackageDir = path.join(build.appRoot, "node_modules", "vite");
  await mkdir(vitePackageDir, { recursive: true });
  await writeFile(path.join(vitePackageDir, "package.json"), '{"version":"8.1.0"}\n', "utf8");
  assert.deepEqual(plugin.config({ build: { sourcemap: true }, root: build.appRoot }), { build: { rolldownOptions: { output: { keepNames: true } } } });
  const outputs = [{ format: "es" }, { format: "cjs", keepNames: false }];
  assert.equal(plugin.config({ build: { rolldownOptions: { output: outputs }, sourcemap: true }, root: build.appRoot }), null);
  assert.deepEqual(outputs, [{ format: "es" }, { format: "cjs", keepNames: false }]);
}

/**
 * @param {Build} build
 * @param {string} manifestPath
 * @returns {Promise<void>}
 */
async function assertViteOutput(build, manifestPath) {
  const minified = await readText(jsPath(build));
  const sourceMap = await readJson(mapPath(build));
  const manifest = await readJson(manifestPath);
  assert.deepEqual(
    {
      debugId: pick(sourceMap, "debug_id"),
      hasSourcesContent: pick(manifest, "artifacts.0.sourceMap.hasSourcesContent"),
      minifiedPathPrefix: pick(manifest, "minifiedPathPrefix"),
      minifiedUrl: pick(manifest, "artifacts.0.minifiedSource.minifiedUrl"),
      projectId: pick(manifest, "projectId"),
      sources: pick(sourceMap, "sources"),
      sourcesContent: pick(sourceMap, "sourcesContent"),
      status: pick(manifest, "validation.status")
    },
    {
      debugId: pick(manifest, "artifacts.0.debugId"),
      hasSourcesContent: false,
      minifiedPathPrefix: CDN_PREFIX,
      minifiedUrl: `${CDN_PREFIX}/assets/app.js`,
      projectId: PROJECT_ID,
      sources: ["src/main.js"],
      sourcesContent: undefined,
      status: "ready"
    }
  );
  assert.match(minified, /debugId=[0-9a-f-]{36}/u);
  assertExcludes(JSON.stringify(manifest), ["source-fixture-marker", "cache=placeholder", "fragment", build.root]);
}

await test("Vite release-artifact plugin prepares a build output and writes a ready manifest", async () => {
  await withBuild(async (build) => {
    const manifestPath = path.join(build.buildDir, "logbrew-release-artifacts.json");
    const plugin = createLogBrewViteReleaseArtifactsPlugin({ ...IDENTITY, manifestPath, minifiedPathPrefix: `${CDN_PREFIX}?cache=placeholder#fragment`, projectId: PROJECT_ID });
    assert.deepEqual({ apply: plugin.apply, enforce: plugin.enforce, name: plugin.name }, { apply: "build", enforce: "post", name: "logbrew-vite-release-artifacts" });
    await assertConfigChanges(plugin, build);
    plugin.configResolved({ build: { outDir: "dist" }, root: build.appRoot });
    await plugin.writeBundle();
    await assertViteOutput(build, manifestPath);
  });
});

await test("Vite release-artifact plugin can dry-run a hosted upload after manifest creation", async () => {
  await withBuild(async (build) => {
    /** @type {string[]} */
    const messages = [];
    const plugin = pluginWithUpload(HOSTED_DRY_RUN)();
    plugin.configResolved({ build: { outDir: "dist" }, logger: { info: (message) => { messages.push(message); } }, root: build.appRoot });
    await plugin.writeBundle();
    assert.deepEqual(messages, ["LogBrew release artifacts: dry_run (1 artifact)"]);
    const manifest = await readJson(path.join(build.buildDir, "logbrew-release-artifacts.json"));
    assert.equal(pick(manifest, "projectId"), PROJECT_ID);
  });
});

await test("Vite hosted release-artifact upload requires project identity", () => {
  assert.throws(
    () => createLogBrewViteReleaseArtifactsPlugin({ ...IDENTITY, minifiedPathPrefix: CDN_PREFIX, upload: HOSTED_DRY_RUN }),
    /hosted upload requires projectId/u
  );
});

await test("Vite release-artifact upload rejects unsafe hosted endpoints before build output changes", () => {
  assert.throws(pluginWithUpload({ ...HOSTED_DRY_RUN, endpoint: `${HOSTED_ENDPOINT}?marker=hidden#fragment` }), /must use https:\/\/api\.logbrew\.co/u);
});

await test("Vite release-artifact upload validates bounded retry settings", () => {
  assert.throws(pluginWithUpload({ ...HOSTED_DRY_RUN, maxRetries: 11 }), /maxRetries must be an integer from 0 to 10/u);
});

await test("Vite release-artifact upload rejects unknown settings", () => {
  const upload = { ...HOSTED_DRY_RUN, retryDelaySeconds: 1 };
  assert.throws(pluginWithUpload(upload), /unknown upload option retryDelaySeconds/u);
});

await test("Vite release-artifact upload failure exposes only a bounded status", async () => {
  await withBuild(async (build) => {
    const authEnvName = `LOGBREW_TEST_RELEASE_ARTIFACT_AUTH_${randomUUID().replaceAll("-", "_").toUpperCase()}`;
    const plugin = pluginWithUpload({ allowHostedUpload: true, endpoint: HOSTED_ENDPOINT, tokenEnv: authEnvName })();
    plugin.configResolved({ build: { outDir: "dist" }, root: build.appRoot });
    await assert.rejects(plugin.writeBundle(), (thrown) => {
      assert.ok(thrown instanceof Error);
      assert.match(thrown.message, /upload-js failed: auth_missing/u);
      assert.equal(thrown.message.includes(authEnvName), false);
      return true;
    });
  });
});
