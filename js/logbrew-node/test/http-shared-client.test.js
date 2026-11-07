import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { RecordingTransport } from "@logbrew/sdk";
import { createLogBrewNodeClient, withLogBrewHttpHandler } from "@logbrew/node";

test("HTTP handler keeps an application client open across requests", { timeout: 10_000 }, async (t) => {
  const client = createLogBrewNodeClient({ serverApiKey: "LOGBREW_SERVER_API_KEY", automaticDelivery: false });
  const transport = RecordingTransport.alwaysAccept();
  const flushes = new EventTarget();
  const captureErrors = [];
  const settle = () => flushes.dispatchEvent(new Event("flushed"));
  const server = createServer(withLogBrewHttpHandler((req, res) => {
    if (req.url === "/fail") {
      throw new TypeError("checkout failed");
    }
    res.end("ok");
  }, {
    client,
    transport,
    onFlush: settle,
    onCaptureError(error) {
      captureErrors.push(error);
      settle();
    },
    onError(_error, { res }) { res.statusCode = 500; res.end("failed"); }
  }));
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const requestAndFlush = async (path) => {
    const flushed = once(flushes, "flushed");
    await (await fetch(`http://127.0.0.1:${server.address().port}${path}`)).text();
    await flushed;
  };

  await requestAndFlush("/ok");
  await requestAndFlush("/fail");
  await requestAndFlush("/ok");

  assert.deepEqual(captureErrors, []);
  const types = transport.sentBodies.flatMap((body) => JSON.parse(body).events.map(({ type }) => type));
  assert.equal(types.filter((type) => type === "span").length, 2);
  assert.ok(types.includes("issue"));
  client.log("evt_after_requests", "2026-06-02T10:00:00Z", { level: "info", message: "still open" });
  assert.equal(client.pendingEvents(), 1);
});
