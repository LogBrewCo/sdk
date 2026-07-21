import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withLogBrewNextReleaseArtifacts } from "../release-artifacts.js";

const PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "logbrew-next-release-artifacts-"));
}

function writeNextChunk(buildDir) {
  fs.mkdirSync(buildDir, { recursive: true });
  const appRoot = path.resolve(buildDir, "../../..");
  const sourcePath = path.join(appRoot, "components", "CheckoutProbe.jsx");
  const jsPath = path.join(buildDir, "checkout.js");
  const mapPath = `${jsPath}.map`;
  const map = {
    version: 3,
    file: "checkout.js",
    sources: [sourcePath],
    sourcesContent: ["const localSourceMarker = 'should not ship';"],
    names: [],
    mappings: "AAAA",
  };
  fs.writeFileSync(jsPath, "console.log('checkout');\n//# sourceMappingURL=checkout.js.map\n", "utf8");
  fs.writeFileSync(mapPath, JSON.stringify(map), "utf8");
  return { jsPath, mapPath };
}

test("Next release-artifact helper wraps config and writes a ready manifest after production compile", async () => {
  const root = tempDir();
  try {
    const distDir = path.join(root, ".next");
    const chunksDir = path.join(distDir, "static", "chunks");
    const { mapPath } = writeNextChunk(chunksDir);
    const calls = [];
    const existingConfig = {
      compiler: {
        async runAfterProductionCompile(context) {
          calls.push({ distDir: context.distDir });
        },
      },
      env: { APP_ENV: "test" },
    };

    const config = withLogBrewNextReleaseArtifacts(existingConfig, {
      release: "2026.06.18-next-helper",
      environment: "production",
      service: "checkout-next-web",
      projectId: PROJECT_ID,
      repositoryUrl: "https://github.com/LogBrewCo/sdk",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      stripSourcePrefix: [root],
    });

    assert.equal(config.productionBrowserSourceMaps, true);
    assert.equal(config.env.APP_ENV, "test");
    assert.equal(typeof config.compiler.runAfterProductionCompile, "function");
    assert.equal(existingConfig.productionBrowserSourceMaps, undefined);

    await config.compiler.runAfterProductionCompile({ distDir });

    const manifestPath = path.join(distDir, "logbrew-release-artifacts.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const sourceMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));

    assert.deepEqual(calls, [{ distDir }]);
    assert.equal(manifest.validation.status, "ready");
    assert.equal(manifest.release, "2026.06.18-next-helper");
    assert.equal(manifest.environment, "production");
    assert.equal(manifest.service, "checkout-next-web");
    assert.equal(manifest.projectId, PROJECT_ID);
    assert.equal(manifest.artifacts.length, 1);
    assert.equal(manifest.artifacts[0].minifiedSource.minifiedUrl, "app:///_next/static/chunks/checkout.js");
    assert.equal(manifest.artifacts[0].sourceMap.hasSourcesContent, false);
    assert.equal(sourceMap.sourcesContent, undefined);
    assert.match(manifest.artifacts[0].debugId, /^[0-9a-f-]{36}$/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Next release-artifact helper preserves explicit source-map settings and async config shape", async () => {
  const wrapped = withLogBrewNextReleaseArtifacts(
    async () => ({
      productionBrowserSourceMaps: false,
      compiler: {},
    }),
    {
      release: "2026.06.18-next-helper",
      environment: "production",
      service: "checkout-next-web",
    },
  );

  const config = await wrapped("phase-production-build", { defaultConfig: {} });

  assert.equal(config.productionBrowserSourceMaps, false);
  assert.equal(typeof config.compiler.runAfterProductionCompile, "function");
});

test("Next release-artifact helper can dry-run hosted upload after the app hook", async () => {
  const root = tempDir();
  const messages = [];
  const originalInfo = console.info;
  try {
    const distDir = path.join(root, ".next");
    const chunksDir = path.join(distDir, "static", "chunks");
    writeNextChunk(chunksDir);
    const calls = [];
    console.info = (message) => messages.push(message);

    const config = withLogBrewNextReleaseArtifacts(
      {
        compiler: {
          async runAfterProductionCompile() {
            calls.push("app");
          },
        },
      },
      {
        release: "web@1.2.3",
        environment: "production",
        service: "checkout-next-web",
        projectId: PROJECT_ID,
        root,
        upload: {
          endpoint: "https://api.logbrew.com/api/release-artifacts",
          allowHostedUpload: true,
          dryRun: true,
        },
      },
    );

    await config.compiler.runAfterProductionCompile({ distDir });

    assert.deepEqual(calls, ["app"]);
    assert.deepEqual(messages, ["LogBrew release artifacts: dry_run (1 artifact)"]);
  } finally {
    console.info = originalInfo;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Next release-artifact upload rejects a non-callable app production hook", () => {
  assert.throws(
    () => withLogBrewNextReleaseArtifacts(
      { compiler: { runAfterProductionCompile: "not-a-function" } },
      {
        release: "web@1.2.3",
        environment: "production",
        service: "checkout-next-web",
        projectId: PROJECT_ID,
        upload: {
          endpoint: "https://api.logbrew.com/api/release-artifacts",
          allowHostedUpload: true,
          dryRun: true,
        },
      },
    ),
    /runAfterProductionCompile must be a function when upload is enabled/u,
  );
});
