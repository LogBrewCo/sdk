import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createNodeFetchTransport } from "../index.js";

async function sendThrough(t, headers, body) {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(429, { "content-type": "application/json", ...headers });
      res.end(body);
    });
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
  }));
  const { port } = server.address();
  return createNodeFetchTransport({ endpoint: `http://127.0.0.1:${port}/v1/events` }).send("lb_test_key", "{}");
}

test("429 Retry-After seconds and a rate_limited code reach the client", async (t) => {
  const response = await sendThrough(t, { "Retry-After": "30" }, JSON.stringify({ code: "rate_limited" }));
  assert.deepEqual(response, { statusCode: 429, attempts: 1, retryAfterMs: 30_000, errorCode: "rate_limited" });
});

test("429 Retry-After HTTP date becomes a delay", async (t) => {
  const date = new Date(Date.now() + 120_000).toUTCString();
  assert.match(date, /GMT$/u);
  const response = await sendThrough(t, { "Retry-After": date }, "");
  assert.ok(response.retryAfterMs > 110_000 && response.retryAfterMs <= 120_000);
  assert.equal(Object.hasOwn(response, "errorCode"), false);
});

test("429 usage_limit_exceeded code is reported and unreadable Retry-After is ignored", async (t) => {
  const response = await sendThrough(t, { "Retry-After": "soon" }, JSON.stringify({ code: "usage_limit_exceeded" }));
  assert.deepEqual(response, { statusCode: 429, attempts: 1, errorCode: "usage_limit_exceeded" });
});

test("429 body over 4 KiB or with an unknown code is not read as a code", async (t) => {
  const large = await sendThrough(t, {}, JSON.stringify({ code: "rate_limited", pad: "x".repeat(5000) }));
  assert.deepEqual(large, { statusCode: 429, attempts: 1 });
  const unknown = await sendThrough(t, {}, JSON.stringify({ code: "private detail" }));
  assert.deepEqual(unknown, { statusCode: 429, attempts: 1 });
});
