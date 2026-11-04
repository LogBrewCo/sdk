import Fastify from "fastify";
import { setLogBrewUser } from "@logbrew/node";
import { logbrewFastifyPlugin } from "@logbrew/fastify";

process.env.LOGBREW_RELEASE = "checkout@1.2.3";
process.env.LOGBREW_ENVIRONMENT = "production";
process.env.LOGBREW_SERVICE_NAME = "checkout-api";
const app = Fastify({ logger: { level: "info" } });
await app.register(logbrewFastifyPlugin, {
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  endpoint: process.env.LOGBREW_CAPTURE_ENDPOINT,
  captureApplicationLogs: true,
  captureRequestMetrics: true
});
app.addHook("preHandler", async () => {
  setLogBrewUser("user_123");
});
app.get("/checkout/:cartId", async (request) => {
  request.log.info("checkout started");
  return { ok: true };
});
app.get("/fail/:cartId", async (request) => {
  request.log.warn("payment step failing");
  throw new Error("payment declined");
});
app.setErrorHandler((error, _request, reply) => {
  reply.code(500).send({ error: error.message });
});

const base = await app.listen({ port: 0, host: "127.0.0.1" });
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
await (await fetch(`${base}/checkout/cart-1`, { headers: { traceparent } })).text();
await (await fetch(`${base}/fail/cart-2`, { headers: { traceparent } })).text();
await new Promise((resolve) => setTimeout(resolve, 500));
await app.close();
