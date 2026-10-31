import {
  EXIT_BLOCKED,
  assertExcludes,
  joinedErrors,
  jsPath,
  mapPath,
  parseJson,
  pick,
  prepareArgs,
  prepareBuild,
  readJson,
  readText,
  runCli,
  strings,
  succeeded,
  withBuild
} from "./release-artifacts-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";

/**
 * @import { Build } from "./release-artifacts-helpers.js"
 */

const REGISTRY_EXPRESSION = 'Symbol.for("logbrew.release-artifact.debug-ids")';
const EXPECTED_CHANGES = [
  "minifiedSource.debugId",
  "minifiedSource.runtimeDebugId",
  "sourceMap.debug_id",
  "sourceMap.sources",
  "sourceMap.sourcesContent"
];
const DEBUG_ID_RE = /debugId=(?<debugId>[A-Za-z0-9-]+)/u;

/**
 * @param {unknown} plan
 * @returns {void}
 */
function assertPreparedPlan(plan) {
  const changes = strings(pick(plan, "artifacts.0.changes"));
  changes.sort();
  assert.deepEqual(changes, EXPECTED_CHANGES);
  assert.deepEqual(
    {
      status: pick(plan, "validation.status"),
      stripSourcePrefixCount: pick(plan, "stripSourcePrefixCount"),
      stripSourcesContent: pick(plan, "stripSourcesContent"),
      writeApplied: pick(plan, "writeApplied")
    },
    { status: "ready", stripSourcePrefixCount: 1, stripSourcesContent: true, writeApplied: true }
  );
}

/**
 * @param {string} minified
 * @param {unknown} sourceMap
 * @returns {void}
 */
function assertPreparedFiles(minified, sourceMap) {
  const debugId = DEBUG_ID_RE.exec(minified)?.groups?.["debugId"] ?? "";
  assert.match(debugId, /^[0-9a-f-]{36}$/u);
  assert.ok(minified.startsWith(";try{"));
  assert.ok(minified.includes(REGISTRY_EXPRESSION));
  assert.ok(minified.split("\n").some((line) => line.includes("assets/app.js") && line.includes(debugId)));
  assert.deepEqual(
    {
      debugId: pick(sourceMap, "debug_id"),
      mappings: pick(sourceMap, "mappings"),
      sources: pick(sourceMap, "sources"),
      sourcesContent: pick(sourceMap, "sourcesContent")
    },
    { debugId, mappings: ";AAAA", sources: ["src/main.js"], sourcesContent: undefined }
  );
}

/**
 * @param {Build} build
 * @returns {Promise<void>}
 */
async function assertSecondRunUnchanged(build) {
  const minified = await readText(jsPath(build));
  const sourceMap = await readJson(mapPath(build));
  succeeded(await runCli(prepareArgs(build, true)));
  assert.equal(await readText(jsPath(build)), minified);
  assert.deepEqual(await readJson(mapPath(build)), sourceMap);
}

await test("prepare-js injects Debug IDs and strips source content from a local build", async () => {
  await withBuild(async (build) => {
    const result = await runCli(prepareArgs(build, true));
    assertPreparedPlan(succeeded(result));
    assertExcludes(result.stdout, ["source-fixture-marker", build.root]);
    assertPreparedFiles(await readText(jsPath(build)), await readJson(mapPath(build)));
    await assertSecondRunUnchanged(build);
  });
});

/**
 * @param {Build} build
 * @returns {Promise<void>}
 */
async function addShebang(build) {
  const original = await readText(jsPath(build));
  const sourceMap = await readJson(mapPath(build));
  assert.ok(typeof sourceMap === "object" && sourceMap !== null);
  const shifted = { ...sourceMap, mappings: `;${String(pick(sourceMap, "mappings"))}` };
  await writeFile(jsPath(build), `#!/usr/bin/env bun\n${original}`, "utf8");
  await writeFile(mapPath(build), `${JSON.stringify(shifted)}\n`, "utf8");
}

await test("prepare-js preserves an executable shebang while shifting generated mappings", async () => {
  await withBuild(async (build) => {
    await addShebang(build);
    await prepareBuild(build, true);
    const prepared = await readText(jsPath(build));
    assert.ok(prepared.startsWith("#!/usr/bin/env bun\n;try{"));
    const sourceMap = await readJson(mapPath(build));
    assert.equal(pick(sourceMap, "mappings"), ";;AAAA");
  });
});

/**
 * @param {Build} build
 * @param {string} expected
 * @returns {Promise<void>}
 */
async function assertBlockedWithoutWrites(build, expected) {
  const originalJs = await readText(jsPath(build));
  const originalMap = await readText(mapPath(build));
  const result = await runCli(["prepare-js", "--build-dir", build.buildDir, "--write"]);
  assert.equal(result.status, EXIT_BLOCKED, result.stderr);
  assert.ok(joinedErrors(parseJson(result.stdout)).includes(expected));
  assert.equal(await readText(jsPath(build)), originalJs);
  assert.equal(await readText(mapPath(build)), originalMap);
}

await test("prepare-js leaves unsupported source transformations unchanged", async () => {
  await withBuild(async (build) => {
    const regular = await readJson(mapPath(build));
    const originalJs = await readText(jsPath(build));
    const indexMap = { file: "app.js", sections: [{ map: regular, offset: { column: 0, line: 0 } }], version: 3 };
    await writeFile(mapPath(build), `${JSON.stringify(indexMap)}\n`, "utf8");
    await assertBlockedWithoutWrites(build, "mappings must be a non-empty string");
    await writeFile(jsPath(build), `/* license */\n"use strict";\n${originalJs}`, "utf8");
    await writeFile(mapPath(build), `${JSON.stringify(regular)}\n`, "utf8");
    await assertBlockedWithoutWrites(build, "cannot precede a script directive");
  });
});
