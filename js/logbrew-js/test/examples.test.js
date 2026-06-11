import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const SUPPORTED_EVENT_TYPES = ["release", "environment", "issue", "log", "span", "action"];
const EXPECTED_EVENT_COUNT = SUPPORTED_EVENT_TYPES.length;

function parseLastJsonObject(text) {
  const lines = text.trim().split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith("{")) {
      return JSON.parse(lines.slice(index).join("\n"));
    }
  }
  throw new Error(`no JSON object found in output:\n${text}`);
}

function parseLastJsonLine(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith("{")) {
      return JSON.parse(lines[index]);
    }
  }
  throw new Error(`no JSON line found in output:\n${text}`);
}

function assertEventTypes(payload) {
  assert.deepEqual(payload.events.map((event) => event.type), SUPPORTED_EVENT_TYPES);
}

function assertSuccessSummary(summary) {
  assert.deepEqual(summary, {
    ok: true,
    status: 202,
    attempts: 1,
    events: EXPECTED_EVENT_COUNT
  });
}

function assertCompactSuccessSummary(output) {
  assert.match(
    output,
    new RegExp(`\\{"ok":true,"status":202,"attempts":1,"events":${EXPECTED_EVENT_COUNT}\\}`)
  );
}

function assertOutputIncludesEventTypes(output) {
  for (const eventType of SUPPORTED_EVENT_TYPES) {
    assert.match(output, new RegExp(`"type": "${eventType}"`));
  }
}

function assertAgentTimelinePayload(payload) {
  assert.equal(payload.sdk.name, "checkout-agent-timeline");
  assert.deepEqual(payload.events.map((event) => event.id), [
    "evt_checkout_started",
    "evt_payment_api"
  ]);
  assert.deepEqual(payload.events.map((event) => event.type), ["action", "action"]);
  assert.deepEqual(payload.events.map((event) => event.attributes.status), ["success", "failure"]);
  assert.equal(payload.events[0].attributes.metadata.source, "product.action");
  assert.equal(payload.events[0].attributes.metadata.routeTemplate, "/checkout/:step");
  assert.equal(payload.events[0].attributes.metadata.funnel, "checkout");
  assert.equal(payload.events[1].attributes.metadata.source, "network.milestone");
  assert.equal(payload.events[1].attributes.metadata.routeTemplate, "/payments/123");
  assert.equal(payload.events[1].attributes.metadata.statusCode, 503);
  assert.equal(payload.events[1].attributes.metadata.method, "POST");
  assert.equal(payload.events[1].attributes.metadata.retryable, true);

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /card=private|coupon=private|#payment|debug heartbeat/);
}

function assertAgentTimelineSummary(summary) {
  assert.deepEqual(summary, {
    ok: true,
    events: 2,
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01",
    status: 202
  });
}

test("repo checkout launcher list prints repo commands", () => {
  const result = spawnSync(process.execPath, ["examples/index.mjs", "--list"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
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

test("repo checkout launcher help prints repo helper and launcher commands", () => {
  const result = spawnSync(process.execPath, ["examples/index.mjs", "--help"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: node examples\/index\.mjs \[--list\] \[example\]/m);
  assert.match(result.stdout, /Run the repo-checkout LogBrew SDK JavaScript examples before install\./);
  assert.match(result.stdout, /default \(real-user-smoke\) -> cd js\/logbrew-js && node examples\/index\.mjs/);
  assert.match(result.stdout, /agent-timeline -> cd js\/logbrew-js && node examples\/index\.mjs agent-timeline/);
  assert.match(
    result.stdout,
    /agent-timeline:cjs -> cd js\/logbrew-js\/examples && npm run agent-timeline:cjs \| cd js\/logbrew-js\/examples && pnpm run agent-timeline:cjs/
  );
  assert.match(
    result.stdout,
    /readme-example -> cd js\/logbrew-js\/examples && npm run readme-example \| cd js\/logbrew-js\/examples && pnpm run readme-example/
  );
  assert.match(
    result.stdout,
    /real-user-smoke:cjs -> cd js\/logbrew-js\/examples && npm run real-user-smoke:cjs \| cd js\/logbrew-js\/examples && pnpm run real-user-smoke:cjs/
  );
});

test("repo checkout CommonJS README example runs directly", () => {
  const result = spawnSync(process.execPath, ["examples/readme-example.cjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assertEventTypes(JSON.parse(result.stdout));
  assertSuccessSummary(JSON.parse(result.stderr));
});

test("repo checkout ESM README example runs directly", () => {
  const result = spawnSync(process.execPath, ["examples/readme-example.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assertEventTypes(JSON.parse(result.stdout));
  assertSuccessSummary(JSON.parse(result.stderr));
});

test("repo checkout launcher runs the ESM README example", () => {
  const result = spawnSync(process.execPath, ["examples/index.mjs", "readme-example"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assertEventTypes(JSON.parse(result.stdout));
  assertSuccessSummary(JSON.parse(result.stderr));
});

test("repo checkout ESM agent timeline example runs directly", () => {
  const result = spawnSync(process.execPath, ["examples/agent-timeline.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assertAgentTimelinePayload(JSON.parse(result.stdout));
  assertAgentTimelineSummary(JSON.parse(result.stderr));
});

test("repo checkout CommonJS agent timeline example runs directly", () => {
  const result = spawnSync(process.execPath, ["examples/agent-timeline.cjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assertAgentTimelinePayload(JSON.parse(result.stdout));
  assertAgentTimelineSummary(JSON.parse(result.stderr));
});

test("repo checkout launcher runs the CommonJS agent timeline example", () => {
  const result = spawnSync(process.execPath, ["examples/index.mjs", "agent-timeline:cjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assertAgentTimelinePayload(JSON.parse(result.stdout));
  assertAgentTimelineSummary(JSON.parse(result.stderr));
});

test("repo checkout raw ESM smoke example runs directly", () => {
  const result = spawnSync(process.execPath, ["examples/real-user-smoke.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sdk.name, "smoke-app");
  assertEventTypes(payload);
  assertSuccessSummary(JSON.parse(result.stderr));
});

test("repo checkout launcher runs the CommonJS smoke example", () => {
  const result = spawnSync(process.execPath, ["examples/index.mjs", "real-user-smoke:cjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assertEventTypes(JSON.parse(result.stdout));
  assertSuccessSummary(JSON.parse(result.stderr));
});

test("repo checkout launcher default runs the ESM smoke example", () => {
  const result = spawnSync(process.execPath, ["examples/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sdk.name, "smoke-app");
  assertEventTypes(payload);
  assertSuccessSummary(JSON.parse(result.stderr));
});

test("repo checkout npm helper discovery lists available scripts", () => {
  const result = spawnSync("npm", ["run"], {
    cwd: new URL("../examples", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Scripts available in .* via `npm run-script`:/);
  assert.match(result.stdout, /\bhelp\b\s*\n\s+node \.\/index\.mjs --help/);
  assert.match(result.stdout, /\blist\b\s*\n\s+node \.\/index\.mjs --list/);
  assert.match(result.stdout, /\bagent-timeline\b\s*\n\s+node \.\/index\.mjs agent-timeline/);
  assert.match(result.stdout, /\breadme-example\b\s*\n\s+node \.\/index\.mjs readme-example/);
  assert.match(result.stdout, /\breal-user-smoke\b\s*\n\s+node \.\/index\.mjs real-user-smoke/);
});

test("repo checkout npm helper list prints launcher commands", () => {
  const result = spawnSync("npm", ["run", "list"], {
    cwd: new URL("../examples", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /> node \.\/index\.mjs --list/);
  assert.match(result.stdout, /agent-timeline -> cd js\/logbrew-js && node examples\/index\.mjs agent-timeline/);
  assert.match(result.stdout, /readme-example -> cd js\/logbrew-js && node examples\/index\.mjs readme-example/);
  assert.match(result.stdout, /real-user-smoke:cjs -> cd js\/logbrew-js && node examples\/index\.mjs real-user-smoke:cjs/);
  assert.match(result.stdout, /default \(real-user-smoke\) -> cd js\/logbrew-js && node examples\/index\.mjs/);
});

test("repo checkout npm helper help prints helper and launcher commands", () => {
  const result = spawnSync("npm", ["run", "help"], {
    cwd: new URL("../examples", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /> node \.\/index\.mjs --help/);
  assert.match(result.stdout, /^Usage: node examples\/index\.mjs \[--list\] \[example\]/m);
  assert.match(result.stdout, /Run the repo-checkout LogBrew SDK JavaScript examples before install\./);
  assert.match(
    result.stdout,
    /agent-timeline -> cd js\/logbrew-js\/examples && npm run agent-timeline \| cd js\/logbrew-js\/examples && pnpm run agent-timeline/
  );
  assert.match(
    result.stdout,
    /readme-example -> cd js\/logbrew-js\/examples && npm run readme-example \| cd js\/logbrew-js\/examples && pnpm run readme-example/
  );
  assert.match(
    result.stdout,
    /real-user-smoke:cjs -> cd js\/logbrew-js\/examples && npm run real-user-smoke:cjs \| cd js\/logbrew-js\/examples && pnpm run real-user-smoke:cjs/
  );
});

test("repo checkout npm helper runs the ESM README example", () => {
  const result = spawnSync("npm", ["run", "readme-example"], {
    cwd: new URL("../examples", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assertEventTypes(parseLastJsonObject(result.stdout));
  assertSuccessSummary(parseLastJsonLine(result.stderr));
});

test("repo checkout npm helper runs the ESM agent timeline example", () => {
  const result = spawnSync("npm", ["run", "agent-timeline"], {
    cwd: new URL("../examples", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assertAgentTimelinePayload(parseLastJsonObject(result.stdout));
  assertAgentTimelineSummary(parseLastJsonLine(result.stderr));
});

test("repo checkout npm helper runs the CommonJS agent timeline example", () => {
  const result = spawnSync("npm", ["run", "agent-timeline:cjs"], {
    cwd: new URL("../examples", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assertAgentTimelinePayload(parseLastJsonObject(result.stdout));
  assertAgentTimelineSummary(parseLastJsonLine(result.stderr));
});

test("repo checkout npm helper runs the ESM smoke example", () => {
  const result = spawnSync("npm", ["run", "real-user-smoke"], {
    cwd: new URL("../examples", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const payload = parseLastJsonObject(result.stdout);
  assert.equal(payload.sdk.name, "smoke-app");
  assertEventTypes(payload);
  assertSuccessSummary(parseLastJsonLine(result.stderr));
});

test("repo checkout npm helper runs the CommonJS README example", () => {
  const result = spawnSync("npm", ["run", "readme-example:cjs"], {
    cwd: new URL("../examples", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assertEventTypes(parseLastJsonObject(result.stdout));
  assertSuccessSummary(parseLastJsonLine(result.stderr));
});

test("repo checkout npm helper runs the CommonJS smoke example", () => {
  const result = spawnSync("npm", ["run", "real-user-smoke:cjs"], {
    cwd: new URL("../examples", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const payload = parseLastJsonObject(result.stdout);
  assert.equal(payload.sdk.name, "smoke-app-cjs");
  assertEventTypes(payload);
  assertSuccessSummary(parseLastJsonLine(result.stderr));
});

test("repo checkout pnpm helper runs the CommonJS smoke example", () => {
  const result = spawnSync("pnpm", ["run", "real-user-smoke:cjs"], {
    cwd: new URL("../examples/", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"name": "smoke-app-cjs"/);
  assertOutputIncludesEventTypes(result.stdout);
  assertCompactSuccessSummary(`${result.stdout}${result.stderr}`);
});

test("repo checkout pnpm helper discovery lists available scripts", () => {
  const result = spawnSync("pnpm", ["run"], {
    cwd: new URL("../examples/", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Commands available via "pnpm run":/);
  assert.match(result.stdout, /\bhelp\b\s*\n\s+node \.\/index\.mjs --help/);
  assert.match(result.stdout, /\blist\b\s*\n\s+node \.\/index\.mjs --list/);
  assert.match(result.stdout, /\bagent-timeline\b\s*\n\s+node \.\/index\.mjs agent-timeline/);
  assert.match(result.stdout, /\breadme-example\b\s*\n\s+node \.\/index\.mjs readme-example/);
  assert.match(result.stdout, /\breal-user-smoke\b\s*\n\s+node \.\/index\.mjs real-user-smoke/);
});

test("repo checkout pnpm helper list prints launcher commands", () => {
  const result = spawnSync("pnpm", ["run", "list"], {
    cwd: new URL("../examples/", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /agent-timeline -> cd js\/logbrew-js && node examples\/index\.mjs agent-timeline/);
  assert.match(result.stdout, /readme-example -> cd js\/logbrew-js && node examples\/index\.mjs readme-example/);
  assert.match(result.stdout, /real-user-smoke:cjs -> cd js\/logbrew-js && node examples\/index\.mjs real-user-smoke:cjs/);
  assert.match(result.stdout, /default \(real-user-smoke\) -> cd js\/logbrew-js && node examples\/index\.mjs/);
});

test("repo checkout pnpm helper help prints helper and launcher commands", () => {
  const result = spawnSync("pnpm", ["run", "help"], {
    cwd: new URL("../examples/", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: node examples\/index\.mjs \[--list\] \[example\]/m);
  assert.match(result.stdout, /Run the repo-checkout LogBrew SDK JavaScript examples before install\./);
  assert.match(
    result.stdout,
    /agent-timeline -> cd js\/logbrew-js\/examples && npm run agent-timeline \| cd js\/logbrew-js\/examples && pnpm run agent-timeline/
  );
  assert.match(
    result.stdout,
    /readme-example -> cd js\/logbrew-js\/examples && npm run readme-example \| cd js\/logbrew-js\/examples && pnpm run readme-example/
  );
  assert.match(
    result.stdout,
    /real-user-smoke:cjs -> cd js\/logbrew-js\/examples && npm run real-user-smoke:cjs \| cd js\/logbrew-js\/examples && pnpm run real-user-smoke:cjs/
  );
});

test("repo checkout pnpm helper runs the CommonJS README example", () => {
  const result = spawnSync("pnpm", ["run", "readme-example:cjs"], {
    cwd: new URL("../examples/", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"name": "logbrew-js"/);
  assertOutputIncludesEventTypes(result.stdout);
  assertCompactSuccessSummary(`${result.stdout}${result.stderr}`);
});

test("repo checkout pnpm helper runs the ESM agent timeline example", () => {
  const result = spawnSync("pnpm", ["run", "agent-timeline"], {
    cwd: new URL("../examples/", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"name": "checkout-agent-timeline"/);
  assert.match(result.stdout, /"source": "product.action"/);
  assert.match(result.stdout, /"source": "network.milestone"/);
  assert.doesNotMatch(result.stdout, /card=private|coupon=private|#payment|debug heartbeat/);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /\{"ok":true,"events":2,"traceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01","status":202\}/
  );
});

test("repo checkout pnpm helper runs the ESM README example", () => {
  const result = spawnSync("pnpm", ["run", "readme-example"], {
    cwd: new URL("../examples/", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"name": "logbrew-js"/);
  assertOutputIncludesEventTypes(result.stdout);
  assertCompactSuccessSummary(`${result.stdout}${result.stderr}`);
});

test("repo checkout pnpm helper runs the ESM smoke example", () => {
  const result = spawnSync("pnpm", ["run", "real-user-smoke"], {
    cwd: new URL("../examples/", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"name": "smoke-app"/);
  assertOutputIncludesEventTypes(result.stdout);
  assertCompactSuccessSummary(`${result.stdout}${result.stderr}`);
});
