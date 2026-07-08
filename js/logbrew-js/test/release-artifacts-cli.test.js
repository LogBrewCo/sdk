import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI_PATH = new URL("../release-artifacts.js", import.meta.url);
const VITE_PLUGIN_PATH = new URL("../vite-release-artifacts.js", import.meta.url);

function makeBuild() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "logbrew-release-artifacts-"));
  const appRoot = path.join(root, "app");
  const dist = path.join(appRoot, "dist", "assets");
  const sourceDir = path.join(appRoot, "src");
  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, "main.js");
  fs.writeFileSync(sourcePath, "export function checkout() { return 'source-fixture-marker'; }\n", "utf8");
  fs.writeFileSync(
    path.join(dist, "app.js"),
    "function checkout(){throw new Error('source-fixture-marker')}checkout();\n//# sourceMappingURL=app.js.map\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(dist, "app.js.map"),
    `${JSON.stringify({
      version: 3,
      file: "app.js",
      sources: [sourcePath],
      sourcesContent: ["export function checkout() { return 'source-fixture-marker'; }\n"],
      names: ["checkout"],
      mappings: "AAAA"
    })}\n`,
    "utf8"
  );
  return { root, appRoot, buildDir: path.join(appRoot, "dist") };
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI_PATH.pathname, ...args], {
    encoding: "utf8",
    ...options
  });
}

function jsonFromStdout(result) {
  return JSON.parse(result.stdout);
}

test("prepare-js injects Debug IDs and strips source content from a local build", () => {
  const { root, appRoot, buildDir } = makeBuild();
  try {
    const result = runCli([
      "prepare-js",
      "--build-dir",
      buildDir,
      "--strip-sources-content",
      "--strip-source-prefix",
      appRoot,
      "--write"
    ]);

    assert.equal(result.status, 0, result.stderr);
    const plan = jsonFromStdout(result);
    assert.equal(plan.validation.status, "ready");
    assert.equal(plan.writeApplied, true);
    assert.equal(plan.stripSourcesContent, true);
    assert.equal(plan.stripSourcePrefixCount, 1);
    assert.deepEqual(plan.artifacts[0].changes.sort(), [
      "minifiedSource.debugId",
      "sourceMap.debug_id",
      "sourceMap.sources",
      "sourceMap.sourcesContent"
    ].sort());
    assert.doesNotMatch(result.stdout, /source-fixture-marker/);
    assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const minified = fs.readFileSync(path.join(buildDir, "assets", "app.js"), "utf8");
    const sourceMap = JSON.parse(fs.readFileSync(path.join(buildDir, "assets", "app.js.map"), "utf8"));
    const debugId = minified.match(/debugId=([A-Za-z0-9-]+)/u)?.[1];
    assert.match(debugId, /^[0-9a-f-]{36}$/u);
    assert.equal(sourceMap.debug_id, debugId);
    assert.deepEqual(sourceMap.sources, ["src/main.js"]);
    assert.equal(sourceMap.sourcesContent, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manifest-js emits a ready privacy-bounded source-map manifest", () => {
  const { root, appRoot, buildDir } = makeBuild();
  try {
    const prep = runCli([
      "prepare-js",
      "--build-dir",
      buildDir,
      "--strip-sources-content",
      "--strip-source-prefix",
      appRoot,
      "--write"
    ]);
    assert.equal(prep.status, 0, prep.stderr);

    const result = runCli([
      "manifest-js",
      "--build-dir",
      buildDir,
      "--release",
      "web@1.2.3",
      "--environment",
      "production",
      "--service",
      "checkout-web",
      "--minified-path-prefix",
      "https://cdn.example/assets?flag=debug#fragment",
      "--repository-url",
      "https://github.com/example/checkout-web",
      "--commit-sha",
      "abc123"
    ]);

    assert.equal(result.status, 0, result.stderr);
    const manifest = jsonFromStdout(result);
    const artifact = manifest.artifacts[0];
    assert.equal(manifest.validation.status, "ready");
    assert.equal(manifest.minifiedPathPrefix, "https://cdn.example/assets");
    assert.equal(artifact.minifiedSource.minifiedUrl, "https://cdn.example/assets/assets/app.js");
    assert.equal(artifact.sourceMap.hasSourcesContent, false);
    assert.equal(artifact.sourceMap.sourceCount, 1);
    assert.equal(artifact.debugId, artifact.minifiedSource.debugId);
    assert.equal(artifact.debugId, artifact.sourceMap.debugId);
    assert.match(artifact.minifiedSource.artifactSha256, /^[0-9a-f]{64}$/u);
    assert.match(artifact.sourceMap.artifactSha256, /^[0-9a-f]{64}$/u);
    assert.doesNotMatch(result.stdout, /source-fixture-marker|flag=debug|#fragment/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("symbolicate-js resolves a sanitized minified frame through a ready manifest", () => {
  const { root, appRoot, buildDir } = makeBuild();
  try {
    const prep = runCli([
      "prepare-js",
      "--build-dir",
      buildDir,
      "--strip-sources-content",
      "--strip-source-prefix",
      appRoot,
      "--write"
    ]);
    assert.equal(prep.status, 0, prep.stderr);

    const manifestResult = runCli([
      "manifest-js",
      "--build-dir",
      buildDir,
      "--release",
      "web@1.2.3",
      "--environment",
      "production",
      "--service",
      "checkout-web",
      "--minified-path-prefix",
      "https://cdn.example/assets"
    ]);
    assert.equal(manifestResult.status, 0, manifestResult.stderr);
    const manifestPath = path.join(root, "manifest.json");
    fs.writeFileSync(manifestPath, manifestResult.stdout, "utf8");

    const result = runCli([
      "symbolicate-js",
      "--build-dir",
      buildDir,
      "--manifest",
      manifestPath,
      "--stack-frame",
      "at checkout (https://cdn.example/assets/assets/app.js:1:1)"
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = jsonFromStdout(result);
    assert.equal(report.status, "resolved");
    assert.equal(report.generated.path, "assets/app.js");
    assert.equal(report.generated.line, 1);
    assert.equal(report.generated.column, 1);
    assert.equal(report.generated.function, "checkout");
    assert.equal(report.original.source, "src/main.js");
    assert.equal(report.original.line, 1);
    assert.equal(report.original.column, 1);
    assert.equal(report.sourceMap.hasSourcesContent, false);
    assert.doesNotMatch(result.stdout, /source-fixture-marker/);
    assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("symbolicate-js resolves a sanitized SDK issue event through a ready manifest", () => {
  const { root, appRoot, buildDir } = makeBuild();
  try {
    const prep = runCli([
      "prepare-js",
      "--build-dir",
      buildDir,
      "--strip-sources-content",
      "--strip-source-prefix",
      appRoot,
      "--write"
    ]);
    assert.equal(prep.status, 0, prep.stderr);

    const manifestResult = runCli([
      "manifest-js",
      "--build-dir",
      buildDir,
      "--release",
      "web@1.2.3",
      "--environment",
      "production",
      "--service",
      "checkout-web",
      "--minified-path-prefix",
      "https://cdn.example/assets?flag=debug#fragment"
    ]);
    assert.equal(manifestResult.status, 0, manifestResult.stderr);
    const manifest = jsonFromStdout(manifestResult);
    const manifestPath = path.join(root, "manifest.json");
    fs.writeFileSync(manifestPath, manifestResult.stdout, "utf8");

    const issuePath = path.join(root, "issue-event.json");
    fs.writeFileSync(
      issuePath,
      `${JSON.stringify({
        type: "issue",
        id: "evt_issue_001",
        timestamp: "2026-07-06T10:00:00Z",
        attributes: {
          title: "TypeError",
          level: "error",
          metadata: {
            release: "web@1.2.3",
            environment: "production",
            service: "checkout-web",
            runtime: "browser",
            errorFrameFile: "https://cdn.example/assets/assets/app.js?flag=debug#fragment",
            errorFrameLine: 1,
            errorFrameColumn: 1,
            releaseArtifactType: "sourcemap",
            releaseArtifactCodeFile: "https://cdn.example/assets/assets/app.js?flag=debug#fragment",
            releaseArtifactDebugId: manifest.artifacts[0].debugId
          }
        }
      })}\n`,
      "utf8"
    );

    const result = runCli([
      "symbolicate-js",
      "--build-dir",
      buildDir,
      "--manifest",
      manifestPath,
      "--issue-event",
      issuePath
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = jsonFromStdout(result);
    assert.equal(report.status, "resolved");
    assert.deepEqual(report.input, {
      type: "sdk_issue_event",
      issueId: "evt_issue_001",
      metadataSource: "attributes.metadata"
    });
    assert.equal(report.debugId, manifest.artifacts[0].debugId);
    assert.equal(report.generated.path, "assets/app.js");
    assert.equal(report.generated.minifiedUrl, "https://cdn.example/assets/assets/app.js");
    assert.equal(report.generated.line, 1);
    assert.equal(report.generated.column, 1);
    assert.equal(report.original.source, "src/main.js");
    assert.doesNotMatch(result.stdout, /flag=debug|#fragment|source-fixture-marker/);
    assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("symbolicate-js can include explicit local source context without local paths", () => {
  const { root, appRoot, buildDir } = makeBuild();
  try {
    const prep = runCli([
      "prepare-js",
      "--build-dir",
      buildDir,
      "--strip-sources-content",
      "--strip-source-prefix",
      appRoot,
      "--write"
    ]);
    assert.equal(prep.status, 0, prep.stderr);

    const manifestResult = runCli([
      "manifest-js",
      "--build-dir",
      buildDir,
      "--release",
      "web@1.2.3",
      "--environment",
      "production",
      "--service",
      "checkout-web",
      "--minified-path-prefix",
      "https://cdn.example/assets"
    ]);
    assert.equal(manifestResult.status, 0, manifestResult.stderr);
    const manifestPath = path.join(root, "manifest.json");
    fs.writeFileSync(manifestPath, manifestResult.stdout, "utf8");

    const result = runCli([
      "symbolicate-js",
      "--build-dir",
      buildDir,
      "--manifest",
      manifestPath,
      "--stack-frame",
      "at checkout (https://cdn.example/assets/assets/app.js:1:1)",
      "--source-root",
      appRoot,
      "--context-lines",
      "0"
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = jsonFromStdout(result);
    assert.equal(report.status, "resolved");
    assert.equal(report.original.source, "src/main.js");
    assert.equal(report.sourceContext.source, "src/main.js");
    assert.equal(report.sourceContext.startLine, 1);
    assert.deepEqual(report.sourceContext.lines, [
      {
        line: 1,
        text: "export function checkout() { return 'source-fixture-marker'; }",
        highlighted: true
      }
    ]);
    assert.match(result.stdout, /source-fixture-marker/u);
    assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("symbolicate-js resolves bundler-style source context under an explicit source root", () => {
  const { root, appRoot, buildDir } = makeBuild();
  try {
    const prep = runCli([
      "prepare-js",
      "--build-dir",
      buildDir,
      "--strip-sources-content",
      "--strip-source-prefix",
      appRoot,
      "--write"
    ]);
    assert.equal(prep.status, 0, prep.stderr);

    const mapPath = path.join(buildDir, "assets", "app.js.map");
    const sourceMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));
    sourceMap.sources = ["turbopack:///[project]/src/main.js"];
    fs.writeFileSync(mapPath, `${JSON.stringify(sourceMap)}\n`, "utf8");

    const manifestResult = runCli([
      "manifest-js",
      "--build-dir",
      buildDir,
      "--release",
      "web@1.2.3",
      "--environment",
      "production",
      "--service",
      "checkout-web",
      "--minified-path-prefix",
      "https://cdn.example/assets"
    ]);
    assert.equal(manifestResult.status, 0, manifestResult.stderr);
    const manifestPath = path.join(root, "manifest.json");
    fs.writeFileSync(manifestPath, manifestResult.stdout, "utf8");

    const result = runCli([
      "symbolicate-js",
      "--build-dir",
      buildDir,
      "--manifest",
      manifestPath,
      "--stack-frame",
      "at checkout (https://cdn.example/assets/assets/app.js:1:1)",
      "--source-root",
      appRoot,
      "--context-lines",
      "0"
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = jsonFromStdout(result);
    assert.equal(report.status, "resolved");
    assert.equal(report.original.source, "turbopack:///[project]/src/main.js");
    assert.equal(report.sourceContext.source, "src/main.js");
    assert.equal(report.sourceContext.lines[0].text, "export function checkout() { return 'source-fixture-marker'; }");
    assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("upload-js validates a ready manifest and prints a dry-run upload plan", () => {
  const { root, appRoot, buildDir } = makeBuild();
  try {
    const prep = runCli([
      "prepare-js",
      "--build-dir",
      buildDir,
      "--strip-sources-content",
      "--strip-source-prefix",
      appRoot,
      "--write"
    ]);
    assert.equal(prep.status, 0, prep.stderr);

    const manifestResult = runCli([
      "manifest-js",
      "--build-dir",
      buildDir,
      "--release",
      "web@1.2.3",
      "--environment",
      "production",
      "--service",
      "checkout-web",
      "--minified-path-prefix",
      "https://cdn.example/assets"
    ]);
    assert.equal(manifestResult.status, 0, manifestResult.stderr);
    const manifestPath = path.join(root, "manifest.json");
    fs.writeFileSync(manifestPath, manifestResult.stdout, "utf8");

    const result = runCli([
      "upload-js",
      "--build-dir",
      buildDir,
      "--manifest",
      manifestPath,
      "--endpoint",
      "http://127.0.0.1:4319/upload?marker=placeholder#ignored",
      "--dry-run"
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = jsonFromStdout(result);
    assert.equal(report.status, "dry_run");
    assert.equal(report.endpoint, "http://127.0.0.1:4319/upload");
    assert.equal(report.artifactCount, 1);
    assert.equal(report.filePartCount, 2);
    assert.deepEqual(report.attempts, []);
    assert.doesNotMatch(result.stdout, /source-fixture-marker|marker=placeholder|#ignored/);
    assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("upload-js allows an explicit hosted HTTPS dry-run without query or auth leakage", () => {
  const { root, appRoot, buildDir } = makeBuild();
  try {
    const prep = runCli([
      "prepare-js",
      "--build-dir",
      buildDir,
      "--strip-sources-content",
      "--strip-source-prefix",
      appRoot,
      "--write"
    ]);
    assert.equal(prep.status, 0, prep.stderr);

    const manifestResult = runCli([
      "manifest-js",
      "--build-dir",
      buildDir,
      "--release",
      "web@1.2.3",
      "--environment",
      "production",
      "--service",
      "checkout-web",
      "--minified-path-prefix",
      "https://cdn.example/assets"
    ]);
    assert.equal(manifestResult.status, 0, manifestResult.stderr);
    const manifestPath = path.join(root, "manifest.json");
    fs.writeFileSync(manifestPath, manifestResult.stdout, "utf8");

    const result = runCli([
      "upload-js",
      "--build-dir",
      buildDir,
      "--manifest",
      manifestPath,
      "--endpoint",
      "https://api.logbrew.com/api/release-artifacts",
      "--allow-hosted",
      "--dry-run"
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = jsonFromStdout(result);
    assert.equal(report.status, "dry_run");
    assert.equal(report.endpoint, "https://api.logbrew.com/api/release-artifacts");
    assert.equal(report.artifactCount, 1);
    assert.equal(report.filePartCount, 2);
    assert.doesNotMatch(result.stdout, /source-fixture-marker|release-artifact-auth/u);
    assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("upload-js rejects unsafe hosted endpoints even with hosted upload opt-in", () => {
  const { root, appRoot, buildDir } = makeBuild();
  try {
    const prep = runCli([
      "prepare-js",
      "--build-dir",
      buildDir,
      "--strip-sources-content",
      "--strip-source-prefix",
      appRoot,
      "--write"
    ]);
    assert.equal(prep.status, 0, prep.stderr);

    const manifestResult = runCli([
      "manifest-js",
      "--build-dir",
      buildDir,
      "--release",
      "web@1.2.3",
      "--environment",
      "production",
      "--service",
      "checkout-web",
      "--minified-path-prefix",
      "https://cdn.example/assets"
    ]);
    assert.equal(manifestResult.status, 0, manifestResult.stderr);
    const manifestPath = path.join(root, "manifest.json");
    fs.writeFileSync(manifestPath, manifestResult.stdout, "utf8");

    const result = runCli([
      "upload-js",
      "--build-dir",
      buildDir,
      "--manifest",
      manifestPath,
      "--endpoint",
      "https://api.logbrew.com/api/release-artifacts?marker=placeholder#debug",
      "--allow-hosted",
      "--dry-run"
    ]);

    assert.equal(result.status, 4);
    const report = jsonFromStdout(result);
    assert.equal(report.status, "validation_failed");
    assert.match(report.validation.errors.join("\n"), /query strings or fragments/u);
    assert.doesNotMatch(result.stdout, /marker=placeholder|#debug/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("symbolicate-js blocks source maps that still expose local source paths", () => {
  const { root, buildDir } = makeBuild();
  try {
    const prep = runCli([
      "prepare-js",
      "--build-dir",
      buildDir,
      "--strip-sources-content",
      "--write"
    ]);
    assert.equal(prep.status, 0, prep.stderr);

    const manifestResult = runCli([
      "manifest-js",
      "--build-dir",
      buildDir,
      "--release",
      "web@1.2.3",
      "--environment",
      "production",
      "--service",
      "checkout-web",
      "--minified-path-prefix",
      "https://cdn.example/assets"
    ]);
    assert.equal(manifestResult.status, 0, manifestResult.stderr);
    const manifestPath = path.join(root, "manifest.json");
    fs.writeFileSync(manifestPath, manifestResult.stdout, "utf8");

    const result = runCli([
      "symbolicate-js",
      "--build-dir",
      buildDir,
      "--manifest",
      manifestPath,
      "--stack-frame",
      "https://cdn.example/assets/assets/app.js:1:1"
    ]);

    assert.equal(result.status, 1);
    const report = jsonFromStdout(result);
    assert.equal(report.status, "validation_failed");
    assert.match(report.validation.errors.join("\n"), /source map source path must be stripped/);
    assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Vite release-artifact plugin prepares a build output and writes a ready manifest", async () => {
  const { root, appRoot, buildDir } = makeBuild();
  try {
    const { createLogBrewViteReleaseArtifactsPlugin } = await import(VITE_PLUGIN_PATH);
    const manifestPath = path.join(buildDir, "logbrew-release-artifacts.json");
    const plugin = createLogBrewViteReleaseArtifactsPlugin({
      release: "web@1.2.3",
      environment: "production",
      service: "checkout-web",
      minifiedPathPrefix: "https://cdn.example/assets?cache=placeholder#fragment",
      manifestPath
    });

    assert.equal(plugin.name, "logbrew-vite-release-artifacts");
    assert.equal(plugin.apply, "build");
    assert.equal(plugin.enforce, "post");
    assert.deepEqual(plugin.config({ build: {} }, { command: "build", mode: "production" }), {
      build: { sourcemap: "hidden" }
    });

    plugin.configResolved({ root: appRoot, build: { outDir: "dist" } });
    await plugin.closeBundle();

    const minified = fs.readFileSync(path.join(buildDir, "assets", "app.js"), "utf8");
    const sourceMap = JSON.parse(fs.readFileSync(path.join(buildDir, "assets", "app.js.map"), "utf8"));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const serialized = JSON.stringify(manifest);
    const artifact = manifest.artifacts[0];

    assert.equal(manifest.validation.status, "ready");
    assert.equal(manifest.minifiedPathPrefix, "https://cdn.example/assets");
    assert.equal(artifact.minifiedSource.minifiedUrl, "https://cdn.example/assets/assets/app.js");
    assert.equal(artifact.sourceMap.hasSourcesContent, false);
    assert.equal(sourceMap.sourcesContent, undefined);
    assert.deepEqual(sourceMap.sources, ["src/main.js"]);
    assert.match(minified, /debugId=[0-9a-f-]{36}/u);
    assert.equal(sourceMap.debug_id, artifact.debugId);
    assert.doesNotMatch(serialized, /source-fixture-marker|cache=placeholder|fragment/);
    assert.doesNotMatch(serialized, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manifest-js blocks embedded sourcesContent until the build is stripped", () => {
  const { root, buildDir } = makeBuild();
  try {
    const result = runCli([
      "manifest-js",
      "--build-dir",
      buildDir,
      "--release",
      "web@1.2.3",
      "--environment",
      "production",
      "--service",
      "checkout-web",
      "--minified-path-prefix",
      "https://cdn.example/assets"
    ]);

    assert.equal(result.status, 1);
    const manifest = jsonFromStdout(result);
    assert.equal(manifest.validation.status, "blocked");
    assert.match(manifest.validation.errors.join("\n"), /source map contains sourcesContent/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
