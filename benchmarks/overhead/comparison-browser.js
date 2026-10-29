// The comparison browser SDK with its transport replaced by an in-memory stub.
// Serialization still runs: createTransport serializes each envelope before the stub.
import * as Sentry from "@sentry/browser";

const bodies = [];
const transport = (options) =>
  Sentry.createTransport(options, (request) => {
    bodies.push(request.body);
    return Promise.resolve({ statusCode: 200 });
  });

globalThis.bench = {
  init(signal) {
    Sentry.init({
      dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      transport,
      ...(signal === "span" ? { tracesSampleRate: 1.0 } : {})
    });
  },
  error(error) {
    Sentry.captureException(error);
  },
  span(name) {
    Sentry.startSpan({ name }, () => undefined);
  },
  flush: () => Sentry.flush(5000),
  delivered: (signal) => bodies.reduce((count, body) => count + deliveredItems(String(body), signal), 0)
};

// Counts the benchmark's error events or spans in one serialized envelope.
function deliveredItems(envelope, signal) {
  const lines = envelope.split("\n");
  let count = 0;
  for (let i = 1; i < lines.length - 1; i += 2) {
    const { type } = JSON.parse(lines[i]);
    const payload = JSON.parse(lines[i + 1]);
    if (signal === "error" && type === "event") {
      count += 1;
    } else if (signal === "span" && type === "span") {
      count += payload.items.filter((span) => span.name === "checkout.step").length;
    } else if (signal === "span" && type === "transaction" && payload.transaction === "checkout.step") {
      count += 1;
    }
  }
  return count;
}
