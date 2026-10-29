// LogBrew Node.js SDK with its transport replaced by an in-memory stub.
import { randomUUID } from "node:crypto";
import { createIssueAttributesFromError } from "@logbrew/sdk";
import { createLogBrewNodeClient, createLogBrewTraceContext } from "@logbrew/node";

const bodies = [];
const transport = {
  async send(_key, body) {
    bodies.push(body);
    return { statusCode: 202, attempts: 1 };
  }
};
let client;

export default {
  init() {
    client = createLogBrewNodeClient({ apiKey: "LOGBREW_API_KEY", transport });
  },
  error(error) {
    client.issue(randomUUID(), new Date().toISOString(), createIssueAttributesFromError(error));
  },
  span(name) {
    const trace = createLogBrewTraceContext();
    const start = performance.now();
    client.span(randomUUID(), new Date().toISOString(), {
      name,
      traceId: trace.traceId,
      spanId: trace.spanId,
      status: "ok",
      durationMs: performance.now() - start
    });
  },
  flush: () => client.flush(),
  delivered: (signal) =>
    bodies.reduce((count, body) => count + JSON.parse(body).events.filter((event) => counted(event, signal)).length, 0)
};

// The benchmark's own error events or spans; the initial page view is not counted.
const counted = (event, signal) =>
  signal === "error" ? event.type === "issue" : event.type === "span" && event.attributes.name === "checkout.step";
