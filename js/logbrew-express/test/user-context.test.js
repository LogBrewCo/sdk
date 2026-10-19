import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { logbrewErrorHandler, logbrewMiddleware } from "@logbrew/express";

test("req.logbrew.setUser tags every event of its own request and no other request", async (t) => {
  const batches = [];
  let flushes = 0;
  let resolveFlushed;
  const flushed = new Promise((resolve) => { resolveFlushed = resolve; });
  const app = express();
  app.use(logbrewMiddleware({
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    transport: { async send(_key, body) { batches.push(JSON.parse(body)); return { statusCode: 202 }; } },
    onFlush() { flushes += 1; if (flushes === 2) { resolveFlushed(); } }
  }));
  app.get("/account", async (req) => {
    assert.equal(req.logbrew.setUser("user-42"), true);
    await Promise.resolve();
    throw new Error("account failed");
  });
  app.get("/health", (_req, res) => { res.json({ ok: true }); });
  app.use(logbrewErrorHandler({ serverApiKey: "LOGBREW_SERVER_API_KEY" }));
  app.use((_error, _req, res, _next) => { res.status(500).end(); });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;

  await fetch(`${origin}/account`);
  await fetch(`${origin}/health`);
  await flushed;

  const account = batches.find((batch) => batch.events.some((event) => event.type === "issue"));
  const health = batches.find((batch) => batch !== account);
  assert.deepEqual(account.events.map((event) => event.type).sort(), ["issue", "span"]);
  for (const event of account.events) {
    assert.deepEqual(event.attributes.context.subject, { id: "user-42", kind: "user" });
  }
  assert.equal(JSON.stringify(health).includes("subject"), false);
});
