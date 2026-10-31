import {
  CDN_PREFIX,
  EXIT_BLOCKED,
  assertExcludes,
  joinedErrors,
  mapPath,
  parseJson,
  pick,
  prepareBuild,
  readJson,
  runCli,
  runWithManifest,
  succeeded,
  withBuild,
  writeManifest
} from "./release-artifacts-helpers.js";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { writeFile } from "node:fs/promises";

/**
 * @import { Build } from "./release-artifacts-helpers.js"
 */

const FRAME = `at checkout (${CDN_PREFIX}/assets/app.js:2:1)`;
const SOURCE_LINE = "export function checkout() { return 'source-fixture-marker'; }";
const MARKED_URL = `${CDN_PREFIX}/assets/app.js?flag=debug#fragment`;

await test("symbolicate-js resolves a sanitized minified frame through a ready manifest", async () => {
  await withBuild(async (build) => {
    await prepareBuild(build, true);
    const result = await runWithManifest(build, "symbolicate-js", ["--stack-frame", FRAME]);
    const report = succeeded(result);
    assert.deepEqual(
      {
        generated: pick(report, "generated"),
        hasSourcesContent: pick(report, "sourceMap.hasSourcesContent"),
        original: pick(report, "original"),
        status: pick(report, "status")
      },
      {
        generated: { column: 1, function: "checkout", line: 2, minifiedUrl: `${CDN_PREFIX}/assets/app.js`, path: "assets/app.js" },
        hasSourcesContent: false,
        original: { column: 1, line: 1, source: "src/main.js" },
        status: "resolved"
      }
    );
    assertExcludes(result.stdout, ["source-fixture-marker", build.root]);
  });
});

/**
 * @param {Build} build
 * @param {unknown} debugId
 * @returns {Promise<string>}
 */
async function writeIssueEvent(build, debugId) {
  const issuePath = path.join(build.root, "issue-event.json");
  const metadata = {
    environment: "production",
    errorFrameColumn: 1,
    errorFrameFile: MARKED_URL,
    errorFrameLine: 2,
    release: "web@1.2.3",
    releaseArtifactCodeFile: MARKED_URL,
    releaseArtifactDebugId: debugId,
    releaseArtifactType: "sourcemap",
    runtime: "browser",
    service: "checkout-web"
  };
  const event = { attributes: { level: "error", metadata, title: "TypeError" }, id: "evt_issue_001", timestamp: "2026-07-06T10:00:00Z", type: "issue" };
  await writeFile(issuePath, `${JSON.stringify(event)}\n`, "utf8");
  return issuePath;
}

await test("symbolicate-js resolves a sanitized SDK issue event through a ready manifest", async () => {
  await withBuild(async (build) => {
    await prepareBuild(build, true);
    const { manifest, manifestPath } = await writeManifest(build, ["--minified-path-prefix", `${CDN_PREFIX}?flag=debug#fragment`]);
    const debugId = pick(manifest, "artifacts.0.debugId");
    const issuePath = await writeIssueEvent(build, debugId);
    const result = await runCli(["symbolicate-js", "--build-dir", build.buildDir, "--manifest", manifestPath, "--issue-event", issuePath]);
    const report = succeeded(result);
    assert.deepEqual(
      { debugId: pick(report, "debugId"), generated: pick(report, "generated"), input: pick(report, "input"), source: pick(report, "original.source") },
      {
        debugId,
        generated: { column: 1, line: 2, minifiedUrl: `${CDN_PREFIX}/assets/app.js`, path: "assets/app.js" },
        input: { issueId: "evt_issue_001", metadataSource: "attributes.metadata", type: "sdk_issue_event" },
        source: "src/main.js"
      }
    );
    assertExcludes(result.stdout, ["flag=debug", "#fragment", "source-fixture-marker", build.root]);
  });
});

/**
 * @param {Build} build
 * @returns {Promise<{ readonly report: unknown, readonly stdout: string }>}
 */
async function symbolicateWithContext(build) {
  const result = await runWithManifest(build, "symbolicate-js", ["--stack-frame", FRAME, "--source-root", build.appRoot, "--context-lines", "0"]);
  const report = succeeded(result);
  assert.equal(pick(report, "status"), "resolved");
  assertExcludes(result.stdout, [build.root]);
  return { report, stdout: result.stdout };
}

await test("symbolicate-js can include explicit local source context without local paths", async () => {
  await withBuild(async (build) => {
    await prepareBuild(build, true);
    const { report, stdout } = await symbolicateWithContext(build);
    assert.deepEqual(
      { context: pick(report, "sourceContext"), source: pick(report, "original.source") },
      { context: { lines: [{ highlighted: true, line: 1, text: SOURCE_LINE }], source: "src/main.js", startLine: 1 }, source: "src/main.js" }
    );
    assert.ok(stdout.includes("source-fixture-marker"));
  });
});

await test("symbolicate-js resolves bundler-style source context under an explicit source root", async () => {
  await withBuild(async (build) => {
    await prepareBuild(build, true);
    const sourceMap = await readJson(mapPath(build));
    assert.ok(typeof sourceMap === "object" && sourceMap !== null);
    await writeFile(mapPath(build), `${JSON.stringify({ ...sourceMap, sources: ["turbopack:///[project]/src/main.js"] })}\n`, "utf8");
    const { report } = await symbolicateWithContext(build);
    assert.deepEqual(
      { contextSource: pick(report, "sourceContext.source"), source: pick(report, "original.source"), text: pick(report, "sourceContext.lines.0.text") },
      { contextSource: "src/main.js", source: "turbopack:///[project]/src/main.js", text: SOURCE_LINE }
    );
  });
});

await test("symbolicate-js blocks source maps that still expose local source paths", async () => {
  await withBuild(async (build) => {
    await prepareBuild(build, false);
    const result = await runWithManifest(build, "symbolicate-js", ["--stack-frame", `${CDN_PREFIX}/assets/app.js:2:1`]);
    assert.equal(result.status, EXIT_BLOCKED);
    const report = parseJson(result.stdout);
    assert.equal(pick(report, "status"), "validation_failed");
    assert.match(joinedErrors(report), /source map source path must be stripped/u);
    assertExcludes(result.stdout, [build.root]);
  });
});
