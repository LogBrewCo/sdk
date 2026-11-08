import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { LogBrewClient } from "@logbrew/sdk";
import { createLogBrewNodeClient, withLogBrewHttpHandler } from "@logbrew/node";

function recordingFetch() {
  const bodies = [];
  const fetchImpl = async (_endpoint, init) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 202 });
  };
  return { bodies, fetchImpl };
}

async function serve(t, handler) {
  const flushes = new EventTarget();
  const server = createServer(handler(() => flushes.dispatchEvent(new Event("flushed"))));
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return async (path) => {
    const flushed = once(flushes, "flushed");
    await (await fetch(`http://127.0.0.1:${server.address().port}${path}`)).text();
    await flushed;
  };
}

const eventTypes = (bodies) => bodies.flatMap((body) => body.events.map(({ type }) => type));

test("HTTP handler without a transport delivers through the default HTTP transport", { timeout: 10_000 }, async (t) => {
  const { bodies, fetchImpl } = recordingFetch();
  const request = await serve(t, (onFlush) => withLogBrewHttpHandler((_req, res) => { res.end("ok"); }, {
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    fetchImpl,
    onFlush
  }));

  await request("/ok");

  assert.deepEqual(eventTypes(bodies), ["span"]);
});

test("HTTP handler without a transport delivers through the shared client's own transport", { timeout: 10_000 }, async (t) => {
  const { bodies, fetchImpl } = recordingFetch();
  const client = createLogBrewNodeClient({ serverApiKey: "LOGBREW_SERVER_API_KEY", automaticDelivery: false, fetchImpl });
  const request = await serve(t, (onFlush) => withLogBrewHttpHandler((_req, res) => { res.end("ok"); }, { client, onFlush }));

  await request("/ok");

  assert.deepEqual(eventTypes(bodies), ["span"]);
});

test("HTTP handler setup fails when neither the handler nor its client has a transport", () => {
  const client = LogBrewClient.create({
    apiKey: "LOGBREW_SERVER_API_KEY",
    sdkName: "http-server-delivery-test",
    sdkVersion: "0.1.0"
  });

  assert.throws(
    () => withLogBrewHttpHandler((_req, res) => { res.end("ok"); }, { client }),
    { code: "configuration_error" }
  );
});
