import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

const SOURCE_MODULE_URL = new URL("../index.js", import.meta.url).href;

// respond(res) answers one batch; leaving it unanswered models a stalled intake.
async function startIntake(t, respond = (res) => {
  res.writeHead(202, { "content-type": "application/json" });
  res.end("{}");
}) {
  const batches = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      batches.push(JSON.parse(body));
      respond(res);
    });
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { batches, endpoint: `http://127.0.0.1:${server.address().port}/v1/events` };
}

// Queues one log and lets the app end; the body follows the setup lines.
function runApp(body, endpoint) {
  const source = `
    import { createLogBrewNodeClient } from ${JSON.stringify(SOURCE_MODULE_URL)};
    const client = createLogBrewNodeClient({ apiKey: "TEST_API_KEY", endpoint: ${JSON.stringify(endpoint)}, maxRetries: 0 });
    client.log("evt_exit_flush", "2026-10-25T00:00:00.000Z", { message: "last words", level: "info" });
    ${body}
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const startedAt = performance.now();
  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({ code, stderr, elapsedMs: performance.now() - startedAt });
    });
  });
}

function logIds(batches) {
  return batches.flatMap((batch) => batch.events).filter((event) => event.type === "log").map((event) => event.id);
}

test("a queued event is sent when the event loop empties", async (t) => {
  const intake = await startIntake(t);
  const result = await runApp("", intake.endpoint);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(logIds(intake.batches), ["evt_exit_flush"]);
});

test("an explicit shutdown is not repeated when the event loop empties", async (t) => {
  const intake = await startIntake(t);
  const result = await runApp("await client.shutdown();", intake.endpoint);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(intake.batches.length, 1);
});

test("a stalled intake does not hold the process past the exit bound", async (t) => {
  const intake = await startIntake(t, () => undefined);
  const result = await runApp("", intake.endpoint);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(intake.batches.length, 1);
  assert.ok(result.elapsedMs < 8000, `exit took ${result.elapsedMs} ms`);
});

test("a failing intake gets one exit attempt and the process ends", async (t) => {
  const intake = await startIntake(t, (res) => {
    res.writeHead(503);
    res.end();
  });
  const result = await runApp("", intake.endpoint);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(intake.batches.length, 1);
});
