import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import diagnosticsChannel from "node:diagnostics_channel";
import { createServer } from "node:http";
import test from "node:test";

import { RecordingTransport } from "@logbrew/sdk";
import { createLogBrewNodeClient, installLogBrewProcessErrorCapture } from "../index.js";

const SOURCE_MODULE_URL = new URL("../index.js", import.meta.url).href;

async function startIntake(t) {
  const batches = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      batches.push(JSON.parse(body));
      res.writeHead(202, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
  }));
  return { batches, endpoint: `http://127.0.0.1:${server.address().port}/v1/events` };
}

// Runs an app that installs capture and then fails; the body follows the setup lines.
function runApp(body, { endpoint, nodeArgs = [], options = "", runtime = process.execPath }) {
  const source = `
    import { createLogBrewNodeClient, installLogBrewProcessErrorCapture, runWithLogBrewTrace } from ${JSON.stringify(SOURCE_MODULE_URL)};
    const client = createLogBrewNodeClient({ apiKey: "TEST_API_KEY", endpoint: ${JSON.stringify(endpoint)}, maxRetries: 0 });
    installLogBrewProcessErrorCapture({ client ${options} });
    ${body}
  `;
  const child = spawn(runtime, [...nodeArgs, "--input-type=module", "--eval", source], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const startedAt = performance.now();
  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({ code, stderr, stdout, elapsedMs: performance.now() - startedAt });
    });
  });
}

function issues(batches) {
  return batches.flatMap((batch) => batch.events).filter((event) => event.type === "issue");
}

test("an uncaught exception is delivered before Node exits with code 1", async (t) => {
  const intake = await startIntake(t);
  const result = await runApp(
    `setTimeout(() => { null.checkout(); }, 0);`,
    intake
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /TypeError/u);
  const [issue, ...rest] = issues(intake.batches);
  assert.deepEqual(rest, []);
  assert.equal(issue.attributes.level, "critical");
  assert.deepEqual(issue.attributes.exception, {
    type: "TypeError",
    mechanism: { type: "node.uncaught_exception", handled: false }
  });
  assert.ok(issue.attributes.stackFrames.length > 0);
  assert.equal(issue.attributes.metadata.runtime, "node");
  assert.equal(issue.attributes.metadata.errorStack, undefined);
  assert.equal(issue.attributes.context.resource.runtime.name, "node");
});

test("an unhandled rejection is reported once and still exits with code 1", async (t) => {
  const intake = await startIntake(t);
  const result = await runApp(
    `Promise.reject(new RangeError("checkout total out of range"));`,
    intake
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /RangeError: checkout total out of range/u);
  const reported = issues(intake.batches);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].attributes.level, "critical");
  assert.equal(reported[0].attributes.message, "checkout total out of range");
  assert.deepEqual(reported[0].attributes.exception.mechanism, {
    type: "node.unhandled_rejection",
    handled: false
  });
});

test("a non-Error rejection keeps Node's rejection error text", async (t) => {
  const intake = await startIntake(t);
  const result = await runApp(`Promise.reject("checkout-declined");`, intake);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /ERR_UNHANDLED_REJECTION/u);
  assert.equal(issues(intake.batches).length, 1);
});

test("an app-owned uncaughtException handler keeps the process running", async (t) => {
  const intake = await startIntake(t);
  const result = await runApp(
    `process.on("uncaughtException", () => {
      setTimeout(() => { console.log("still running"); }, 200);
    });
    setTimeout(() => { throw new Error("recovered by app"); }, 0);`,
    intake
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /still running/u);
  assert.equal(issues(intake.batches)[0].attributes.message, "recovered by app");
});

test("warn mode reports a rejection without ending the process", async (t) => {
  const intake = await startIntake(t);
  const result = await runApp(
    `Promise.reject(new Error("warned rejection"));
    setTimeout(() => { console.log("still running"); }, 200);`,
    { ...intake, nodeArgs: ["--unhandled-rejections=warn"] }
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /still running/u);
  const [issue] = issues(intake.batches);
  assert.equal(issue.attributes.level, "error");
  assert.equal(issue.attributes.exception.mechanism.type, "node.unhandled_rejection");
});

test("a crash inside a request trace carries that trace", async (t) => {
  const intake = await startIntake(t);
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const result = await runApp(
    `runWithLogBrewTrace({ traceId: "${traceId}", spanId: "00f067aa0ba902b7", sampled: true }, () => {
      setTimeout(() => { throw new Error("inside request"); }, 0);
    });`,
    intake
  );

  assert.equal(result.code, 1);
  const [issue] = issues(intake.batches);
  assert.equal(issue.attributes.metadata.traceId, traceId);
  assert.equal(issue.attributes.context.trace.traceId, traceId);
});

// Bun has no worker_threads diagnostics channel, so the worker tests run on Node.
test("a worker error the app handles is reported and the app keeps running", async (t) => {
  const intake = await startIntake(t);
  const result = await runApp(
    `const { Worker } = await import("node:worker_threads");
    const worker = new Worker("throw new RangeError('worker failed')", { eval: true });
    worker.on("error", () => process.stdout.write("app handled;"));
    worker.on("exit", () => setTimeout(() => process.stdout.write("still running"), 50));`,
    { ...intake, runtime: "node" }
  );

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "app handled;still running");
  const [issue] = issues(intake.batches);
  assert.equal(issue.attributes.level, "error");
  assert.equal(issue.attributes.exception.type, "RangeError");
  assert.equal(issue.attributes.exception.mechanism.type, "node.worker_error");
  assert.equal(issue.attributes.exception.mechanism.handled, false);
});

test("a worker error without an app listener still ends the process and is reported once", async (t) => {
  const intake = await startIntake(t);
  const result = await runApp(
    `const { Worker } = await import("node:worker_threads");
    new Worker("throw new RangeError('unhandled in worker')", { eval: true });`,
    { ...intake, runtime: "node" }
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /RangeError.*: unhandled in worker/u);
  const reported = issues(intake.batches);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].attributes.level, "critical");
  assert.equal(reported[0].attributes.exception.mechanism.type, "node.uncaught_exception");
});

test("an unreachable intake delays exit by at most the flush timeout", async () => {
  const result = await runApp(
    `setTimeout(() => { throw new Error("intake down"); }, 0);`,
    { endpoint: "http://192.0.2.1:9/v1/events", options: ", flushTimeoutMs: 300" }
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Error: intake down/u);
  assert.ok(result.elapsedMs < 5000, `exit took ${result.elapsedMs} ms`);
});

test("capture installs once and uninstall removes every listener", () => {
  const client = createLogBrewNodeClient({ apiKey: "TEST_API_KEY", transport: RecordingTransport.alwaysAccept() });
  const workers = diagnosticsChannel.channel("worker_threads");
  const before = [process.listenerCount("uncaughtException"), process.listenerCount("unhandledRejection")];
  assert.equal(workers.hasSubscribers, false);
  const handle = installLogBrewProcessErrorCapture({ client });
  assert.throws(() => installLogBrewProcessErrorCapture({ client }), /already installed/u);
  assert.equal(workers.hasSubscribers, true);
  handle.uninstall();
  handle.uninstall();
  assert.deepEqual(
    [process.listenerCount("uncaughtException"), process.listenerCount("unhandledRejection")],
    before
  );
  assert.equal(workers.hasSubscribers, false);
  installLogBrewProcessErrorCapture({ client }).uninstall();
});

test("capture rejects invalid configuration", () => {
  const client = createLogBrewNodeClient({ apiKey: "TEST_API_KEY", transport: RecordingTransport.alwaysAccept() });
  assert.throws(() => installLogBrewProcessErrorCapture(), /config object/u);
  assert.throws(() => installLogBrewProcessErrorCapture({ client: {} }), /LogBrewClient/u);
  assert.throws(() => installLogBrewProcessErrorCapture({ client, flushTimeoutMs: 30_001 }), /flushTimeoutMs/u);
  assert.throws(() => installLogBrewProcessErrorCapture({ client, transport: {} }), /transport\.send/u);
});
