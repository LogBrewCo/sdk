import { captureException, createTransport, flush, init, startSpan } from "@sentry/browser";
import { countComparisonDelivered } from "./delivered.js";

/**
 * @import { InternalBaseTransportOptions, Transport, TransportMakeRequestResponse } from "@sentry/core"
 * @import { Bench } from "./loop.js"
 */

/** @type {unknown[]} */
const bodies = [];
const DELIVERED = { statusCode: 200 };
const FLUSH_TIMEOUT_MS = 5000;
const SAMPLE_EVERY_SPAN = 1;

/**
 * @param {{ readonly body: unknown }} request
 * @returns {Promise<TransportMakeRequestResponse>}
 */
async function makeRequest(request) {
  bodies.push(request.body);
  return DELIVERED;
}

/**
 * @param {Readonly<InternalBaseTransportOptions>} options
 * @returns {Transport}
 */
function transport(options) {
  return createTransport(options, makeRequest);
}

/** @type {Bench} */
const bench = {
  delivered: (signal) => countComparisonDelivered(bodies, signal),
  error(error) {
    captureException(error);
  },
  flush: async () => flush(FLUSH_TIMEOUT_MS),
  init(signal) {
    init({
      dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      transport,
      ...(signal === "span" ? { tracesSampleRate: SAMPLE_EVERY_SPAN } : {})
    });
  },
  span(name) {
    startSpan({ name }, () => undefined);
  }
};

export { bench };
