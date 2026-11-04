import { createServer } from "node:http";
import pino from "pino";
import {
  createLogBrewNodeClient,
  createNodeFetchTransport,
  installLogBrewPinoInstrumentation,
  setLogBrewUser,
  withLogBrewHttpHandler
} from "@logbrew/node";

process.env.LOGBREW_RELEASE = "checkout@1.2.3";
process.env.LOGBREW_ENVIRONMENT = "production";
process.env.LOGBREW_SERVICE_NAME = "checkout-api";
const client = createLogBrewNodeClient({ serverApiKey: "LOGBREW_SERVER_API_KEY", endpoint: process.env.LOGBREW_CAPTURE_ENDPOINT });
const pinoCapture = installLogBrewPinoInstrumentation({ client });
const logger = pino({ level: "info" });

const server = createServer(withLogBrewHttpHandler((req, res) => {
  setLogBrewUser("user_123");
  console.info("handling request");
  logger.info("checkout started");
  if (req.url.startsWith("/fail")) {
    throw new Error("payment declined");
  }
  res.end("ok");
}, { serverApiKey: "LOGBREW_SERVER_API_KEY", transport: createNodeFetchTransport({ endpoint: process.env.LOGBREW_CAPTURE_ENDPOINT }) }));

server.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
await (await fetch(`${base}/checkout`, { headers: { traceparent } })).text();
await (await fetch(`${base}/fail`, { headers: { traceparent } })).text();
await new Promise((resolve) => setTimeout(resolve, 500));
server.close();
pinoCapture.uninstall();
await client.shutdown();
