import { EXIT_OK, PRIVATE_TIMELINE_VALUES, assertCompactSuccessSummary, assertOutputIncludesEventTypes, runPnpm } from "./example-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

await test("repo checkout pnpm helper runs the CommonJS smoke example", async () => {
  const result = await runPnpm(["run", "real-user-smoke:cjs"]);

  assert.equal(result.status, EXIT_OK);
  assert.match(result.stdout, /"name": "smoke-app-cjs"/u);
  assertOutputIncludesEventTypes(result.stdout);
  assertCompactSuccessSummary(`${result.stdout}${result.stderr}`);
});

await test("repo checkout pnpm helper discovery lists available scripts", async () => {
  const result = await runPnpm(["run"]);

  assert.equal(result.status, EXIT_OK);
  assert.match(result.stdout, /Commands available via "pnpm run":/u);
  assert.match(result.stdout, /\bhelp\b\s*\n\s+node \.\/index\.mjs --help/u);
  assert.match(result.stdout, /\blist\b\s*\n\s+node \.\/index\.mjs --list/u);
  assert.match(result.stdout, /\bagent-timeline\b\s*\n\s+node \.\/index\.mjs agent-timeline/u);
  assert.match(result.stdout, /\breadme-example\b\s*\n\s+node \.\/index\.mjs readme-example/u);
  assert.match(result.stdout, /\breal-user-smoke\b\s*\n\s+node \.\/index\.mjs real-user-smoke/u);
});

await test("repo checkout pnpm helper list prints launcher commands", async () => {
  const result = await runPnpm(["run", "list"]);

  assert.equal(result.status, EXIT_OK);
  assert.match(result.stdout, /agent-timeline -> cd js\/logbrew-js && node examples\/index\.mjs agent-timeline/u);
  assert.match(result.stdout, /readme-example -> cd js\/logbrew-js && node examples\/index\.mjs readme-example/u);
  assert.match(result.stdout, /real-user-smoke:cjs -> cd js\/logbrew-js && node examples\/index\.mjs real-user-smoke:cjs/u);
  assert.match(result.stdout, /default \(real-user-smoke\) -> cd js\/logbrew-js && node examples\/index\.mjs/u);
});

await test("repo checkout pnpm helper help prints helper and launcher commands", async () => {
  const result = await runPnpm(["run", "help"]);

  assert.equal(result.status, EXIT_OK);
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

await test("repo checkout pnpm helper runs the CommonJS README example", async () => {
  const result = await runPnpm(["run", "readme-example:cjs"]);

  assert.equal(result.status, EXIT_OK);
  assert.match(result.stdout, /"name": "logbrew-js"/u);
  assertOutputIncludesEventTypes(result.stdout);
  assertCompactSuccessSummary(`${result.stdout}${result.stderr}`);
});

await test("repo checkout pnpm helper runs the ESM agent timeline example", async () => {
  const result = await runPnpm(["run", "agent-timeline"]);

  assert.equal(result.status, EXIT_OK);
  assert.match(result.stdout, /"name": "checkout-agent-timeline"/u);
  assert.match(result.stdout, /"source": "product.action"/u);
  assert.match(result.stdout, /"source": "network.milestone"/u);
  assert.doesNotMatch(result.stdout, PRIVATE_TIMELINE_VALUES);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /\{"ok":true,"events":2,"traceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01","status":202\}/u
  );
});

await test("repo checkout pnpm helper runs the ESM README example", async () => {
  const result = await runPnpm(["run", "readme-example"]);

  assert.equal(result.status, EXIT_OK);
  assert.match(result.stdout, /"name": "logbrew-js"/u);
  assertOutputIncludesEventTypes(result.stdout);
  assertCompactSuccessSummary(`${result.stdout}${result.stderr}`);
});

await test("repo checkout pnpm helper runs the ESM smoke example", async () => {
  const result = await runPnpm(["run", "real-user-smoke"]);

  assert.equal(result.status, EXIT_OK);
  assert.match(result.stdout, /"name": "smoke-app"/u);
  assertOutputIncludesEventTypes(result.stdout);
  assertCompactSuccessSummary(`${result.stdout}${result.stderr}`);
});
