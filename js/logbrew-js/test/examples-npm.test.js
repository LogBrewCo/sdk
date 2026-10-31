import { EXIT_OK, assertAgentTimelinePayload, assertAgentTimelineSummary, assertEventTypes, assertSuccessSummary, parseLastJsonLine, parseLastJsonObject, runNpm } from "./example-helpers.js";
import assert from "node:assert/strict";
import { pick } from "./capture-helpers.js";
import test from "node:test";

await test("repo checkout npm helper discovery lists available scripts", async () => {
  const result = await runNpm(["run"]);

  assert.equal(result.status, EXIT_OK);
  assert.match(result.stdout, /Scripts available in .* via `npm run-script`:/u);
  assert.match(result.stdout, /\bhelp\b\s*\n\s+node \.\/index\.mjs --help/u);
  assert.match(result.stdout, /\blist\b\s*\n\s+node \.\/index\.mjs --list/u);
  assert.match(result.stdout, /\bagent-timeline\b\s*\n\s+node \.\/index\.mjs agent-timeline/u);
  assert.match(result.stdout, /\breadme-example\b\s*\n\s+node \.\/index\.mjs readme-example/u);
  assert.match(result.stdout, /\breal-user-smoke\b\s*\n\s+node \.\/index\.mjs real-user-smoke/u);
});

await test("repo checkout npm helper list prints launcher commands", async () => {
  const result = await runNpm(["run", "list"]);

  assert.equal(result.status, EXIT_OK);
  assert.match(result.stdout, /> node \.\/index\.mjs --list/u);
  assert.match(result.stdout, /agent-timeline -> cd js\/logbrew-js && node examples\/index\.mjs agent-timeline/u);
  assert.match(result.stdout, /readme-example -> cd js\/logbrew-js && node examples\/index\.mjs readme-example/u);
  assert.match(result.stdout, /real-user-smoke:cjs -> cd js\/logbrew-js && node examples\/index\.mjs real-user-smoke:cjs/u);
  assert.match(result.stdout, /default \(real-user-smoke\) -> cd js\/logbrew-js && node examples\/index\.mjs/u);
});

await test("repo checkout npm helper help prints helper and launcher commands", async () => {
  const result = await runNpm(["run", "help"]);

  assert.equal(result.status, EXIT_OK);
  assert.match(result.stdout, /> node \.\/index\.mjs --help/u);
  assert.match(result.stdout, /^Usage: node examples\/index\.mjs \[--list\] \[example\]/mu);
  assert.match(result.stdout, /Run the repo-checkout LogBrew SDK JavaScript examples before install\./u);
  assert.match(
    result.stdout,
    /agent-timeline -> cd js\/logbrew-js\/examples && npm run agent-timeline \| cd js\/logbrew-js\/examples && pnpm run agent-timeline/u
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

await test("repo checkout npm helper runs the ESM README example", async () => {
  const result = await runNpm(["run", "readme-example"]);

  assert.equal(result.status, EXIT_OK);
  assertEventTypes(parseLastJsonObject(result.stdout));
  assertSuccessSummary(parseLastJsonLine(result.stderr));
});

await test("repo checkout npm helper runs the ESM agent timeline example", async () => {
  const result = await runNpm(["run", "agent-timeline"]);

  assert.equal(result.status, EXIT_OK);
  assertAgentTimelinePayload(parseLastJsonObject(result.stdout));
  assertAgentTimelineSummary(parseLastJsonLine(result.stderr));
});

await test("repo checkout npm helper runs the CommonJS agent timeline example", async () => {
  const result = await runNpm(["run", "agent-timeline:cjs"]);

  assert.equal(result.status, EXIT_OK);
  assertAgentTimelinePayload(parseLastJsonObject(result.stdout));
  assertAgentTimelineSummary(parseLastJsonLine(result.stderr));
});

await test("repo checkout npm helper runs the ESM smoke example", async () => {
  const result = await runNpm(["run", "real-user-smoke"]);

  assert.equal(result.status, EXIT_OK);
  const payload = parseLastJsonObject(result.stdout);
  assert.equal(pick(payload, "sdk.name"), "smoke-app");
  assertEventTypes(payload);
  assertSuccessSummary(parseLastJsonLine(result.stderr));
});

await test("repo checkout npm helper runs the CommonJS README example", async () => {
  const result = await runNpm(["run", "readme-example:cjs"]);

  assert.equal(result.status, EXIT_OK);
  assertEventTypes(parseLastJsonObject(result.stdout));
  assertSuccessSummary(parseLastJsonLine(result.stderr));
});

await test("repo checkout npm helper runs the CommonJS smoke example", async () => {
  const result = await runNpm(["run", "real-user-smoke:cjs"]);

  assert.equal(result.status, EXIT_OK);
  const payload = parseLastJsonObject(result.stdout);
  assert.equal(pick(payload, "sdk.name"), "smoke-app-cjs");
  assertEventTypes(payload);
  assertSuccessSummary(parseLastJsonLine(result.stderr));
});
