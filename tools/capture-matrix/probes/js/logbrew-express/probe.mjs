import express from "express";
import pino from "pino";
import { createLogBrewNodeClient, installLogBrewPinoInstrumentation } from "@logbrew/node";
import { logbrewErrorHandler, logbrewMiddleware } from "@logbrew/express";

const endpoint = process.env.LOGBREW_CAPTURE_ENDPOINT;
process.env.LOGBREW_RELEASE = "checkout@1.2.3";
process.env.LOGBREW_ENVIRONMENT = "production";
process.env.LOGBREW_SERVICE_NAME = "checkout-api";
const options = { serverApiKey: "LOGBREW_SERVER_API_KEY", endpoint, captureRequestMetrics: true };
const logClient = createLogBrewNodeClient({ serverApiKey: "LOGBREW_SERVER_API_KEY", endpoint });
const pinoCapture = installLogBrewPinoInstrumentation({ client: logClient });
const logger = pino({ level: "info" });

const app = express();
app.use(logbrewMiddleware(options));
app.use((req, _res, next) => {
  req.logbrew.setUser("user_123");
  next();
});
app.get("/checkout/:cartId", (req, res) => {
  logger.info("checkout started");
  res.json({ ok: true });
});
app.get("/fail/:cartId", () => {
  logger.warn("payment step failing");
  throw new Error("payment declined");
});
app.use(logbrewErrorHandler(options));
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
await (await fetch(`${base}/checkout/cart-1`, { headers: { traceparent } })).text();
await (await fetch(`${base}/fail/cart-2`, { headers: { traceparent } })).text();
await new Promise((resolve) => setTimeout(resolve, 500));
server.close();
await pinoCapture.flush();
pinoCapture.uninstall();
await logClient.shutdown();
