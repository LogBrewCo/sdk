import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { withLogBrewHttpHandler } from "@logbrew/node";

function statusError(message, fields) {
  return Object.assign(new Error(message), fields);
}

async function serve(t, handler, options = {}) {
  const batches = [];
  let resolveFlushed;
  const flushed = new Promise((resolve) => { resolveFlushed = resolve; });
  const server = createServer(withLogBrewHttpHandler(handler, {
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    transport: {
      async send(_key, body) {
        batches.push(JSON.parse(body));
        return { statusCode: 202 };
      }
    },
    onFlush() { resolveFlushed(); },
    ...options
  }));
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/items/42`);
  const text = await response.text();
  await flushed;
  const events = batches.flatMap(({ events: captured }) => captured);
  return { events, status: response.status, text };
}

function issues(events) {
  return events.filter(({ type }) => type === "issue");
}

function requestStatus(events) {
  const span = events.find(({ type }) => type === "span");
  assert.ok(span, "the request span was recorded");
  return span.attributes.metadata.statusCode;
}

test("a thrown 404 is not an issue and its status reaches the client and the request span", async (t) => {
  const { events, status, text } = await serve(t, () => {
    throw statusError("item not found", { statusCode: 404 });
  });

  assert.equal(issues(events).length, 0);
  assert.equal(status, 404);
  assert.equal(text, "Not Found");
  assert.equal(requestStatus(events), 404);
});

test("a rejected 400 handled by onError is not an issue", async (t) => {
  const { events, status } = await serve(t, async () => {
    await Promise.resolve();
    throw statusError("name is required", { status: 400 });
  }, {
    onError(error, { res }) {
      res.statusCode = error.status;
      res.end("bad request");
    }
  });

  assert.equal(issues(events).length, 0);
  assert.equal(status, 400);
  assert.equal(requestStatus(events), 400);
});

test("a handler that writes a 404 response is not an issue", async (t) => {
  const { events, status } = await serve(t, (_req, res) => {
    res.statusCode = 404;
    res.end("missing");
  });

  assert.equal(issues(events).length, 0);
  assert.equal(status, 404);
  assert.equal(requestStatus(events), 404);
});

test("captureClientErrors: true reports a thrown 404 as an issue", async (t) => {
  const { events, status } = await serve(t, () => {
    throw statusError("item not found", { statusCode: 404 });
  }, { captureClientErrors: true });

  assert.equal(issues(events).length, 1);
  assert.equal(issues(events)[0].attributes.message, "item not found");
  assert.equal(status, 404);
});

test("a thrown 500 and an error without a status stay issues", async (t) => {
  for (const error of [statusError("database offline", { statusCode: 503 }), new Error("unexpected")]) {
    const { events, status } = await serve(t, () => { throw error; });

    assert.equal(issues(events).length, 1);
    assert.equal(issues(events)[0].attributes.message, error.message);
    assert.equal(status, 500);
  }
});
