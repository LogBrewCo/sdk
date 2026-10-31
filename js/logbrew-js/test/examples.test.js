import { EXIT_OK, assertAgentTimelinePayload, assertAgentTimelineSummary, assertEventTypes, assertSuccessSummary, runNode } from "./example-helpers.js";
import { parseJson, pick } from "./capture-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

await test("repo checkout launcher list prints repo commands", async () => {
  const result = await runNode(["examples/index.mjs", "--list"]);

  assert.equal(result.status, EXIT_OK);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "agent-timeline -> cd js/logbrew-js && node examples/index.mjs agent-timeline",
    "agent-timeline:esm -> cd js/logbrew-js && node examples/index.mjs agent-timeline:esm",
    "agent-timeline:cjs -> cd js/logbrew-js && node examples/index.mjs agent-timeline:cjs",
    "readme-example -> cd js/logbrew-js && node examples/index.mjs readme-example",
    "readme-example:esm -> cd js/logbrew-js && node examples/index.mjs readme-example:esm",
    "readme-example:cjs -> cd js/logbrew-js && node examples/index.mjs readme-example:cjs",
    "real-user-smoke -> cd js/logbrew-js && node examples/index.mjs real-user-smoke",
    "real-user-smoke:esm -> cd js/logbrew-js && node examples/index.mjs real-user-smoke:esm",
    "real-user-smoke:cjs -> cd js/logbrew-js && node examples/index.mjs real-user-smoke:cjs",
    "default (real-user-smoke) -> cd js/logbrew-js && node examples/index.mjs"
  ]);
});

await test("repo checkout launcher help prints repo helper and launcher commands", async () => {
  const result = await runNode(["examples/index.mjs", "--help"]);

  assert.equal(result.status, EXIT_OK);
  assert.match(result.stdout, /^Usage: node examples\/index\.mjs \[--list\] \[example\]/mu);
  assert.match(result.stdout, /Run the repo-checkout LogBrew SDK JavaScript examples before install\./u);
  assert.match(result.stdout, /default \(real-user-smoke\) -> cd js\/logbrew-js && node examples\/index\.mjs/u);
  assert.match(result.stdout, /agent-timeline -> cd js\/logbrew-js && node examples\/index\.mjs agent-timeline/u);
  assert.match(
    result.stdout,
    /agent-timeline:cjs -> cd js\/logbrew-js\/examples && npm run agent-timeline:cjs \| cd js\/logbrew-js\/examples && pnpm run agent-timeline:cjs/u
  );
  assert.match(
    result.stdout,
    /readme-example -> cd js\/logbrew-js\/examples && npm run readme-example \| cd js\/logbrew-js\/examples && pnpm run readme-example/u
  );
  assert.match(
    result.stdout,
    /real-user-smoke:cjs -> cd js\/logbrew-js\/examples && npm run real-user-smoke:cjs \| cd js\/logbrew-js\/examples && pnpm run real-user-smoke:cjs/u
  );
});

await test("repo checkout CommonJS README example runs directly", async () => {
  const result = await runNode(["examples/readme-example.cjs"]);

  assert.equal(result.status, EXIT_OK);
  assertEventTypes(parseJson(result.stdout));
  assertSuccessSummary(parseJson(result.stderr));
});

await test("repo checkout ESM README example runs directly", async () => {
  const result = await runNode(["examples/readme-example.mjs"]);

  assert.equal(result.status, EXIT_OK);
  assertEventTypes(parseJson(result.stdout));
  assertSuccessSummary(parseJson(result.stderr));
});

await test("repo checkout launcher runs the ESM README example", async () => {
  const result = await runNode(["examples/index.mjs", "readme-example"]);

  assert.equal(result.status, EXIT_OK);
  assertEventTypes(parseJson(result.stdout));
  assertSuccessSummary(parseJson(result.stderr));
});

await test("repo checkout ESM agent timeline example runs directly", async () => {
  const result = await runNode(["examples/agent-timeline.mjs"]);

  assert.equal(result.status, EXIT_OK);
  assertAgentTimelinePayload(parseJson(result.stdout));
  assertAgentTimelineSummary(parseJson(result.stderr));
});

await test("repo checkout CommonJS agent timeline example runs directly", async () => {
  const result = await runNode(["examples/agent-timeline.cjs"]);

  assert.equal(result.status, EXIT_OK);
  assertAgentTimelinePayload(parseJson(result.stdout));
  assertAgentTimelineSummary(parseJson(result.stderr));
});

await test("repo checkout launcher runs the CommonJS agent timeline example", async () => {
  const result = await runNode(["examples/index.mjs", "agent-timeline:cjs"]);

  assert.equal(result.status, EXIT_OK);
  assertAgentTimelinePayload(parseJson(result.stdout));
  assertAgentTimelineSummary(parseJson(result.stderr));
});

await test("repo checkout raw ESM smoke example runs directly", async () => {
  const result = await runNode(["examples/real-user-smoke.mjs"]);

  assert.equal(result.status, EXIT_OK);
  const payload = parseJson(result.stdout);
  assert.equal(pick(payload, "sdk.name"), "smoke-app");
  assertEventTypes(payload);
  assertSuccessSummary(parseJson(result.stderr));
});

await test("repo checkout launcher runs the CommonJS smoke example", async () => {
  const result = await runNode(["examples/index.mjs", "real-user-smoke:cjs"]);

  assert.equal(result.status, EXIT_OK);
  assertEventTypes(parseJson(result.stdout));
  assertSuccessSummary(parseJson(result.stderr));
});

await test("repo checkout launcher default runs the ESM smoke example", async () => {
  const result = await runNode(["examples/index.mjs"]);

  assert.equal(result.status, EXIT_OK);
  const payload = parseJson(result.stdout);
  assert.equal(pick(payload, "sdk.name"), "smoke-app");
  assertEventTypes(payload);
  assertSuccessSummary(parseJson(result.stderr));
});
