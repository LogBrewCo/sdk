import { createAutomaticBrowserEventId } from "./trace-context.js";

/**
 * @import { LogBrewClient, Metadata, MetricAttributes, SpanAttributes } from "@logbrew/sdk"
 * @import { LogBrewBrowserEvent } from "./index.js"
 * @typedef {Readonly<{ name: string, unit: string, value: unknown, keys: readonly string[] }>} TimingMetric
 */

const REQUEST_METRIC_KEYS = ["method", "requestPath", "statusCode"];
const NO_DURATION = 0;

/**
 * Sends a timing the SDK already measured for a span as a histogram metric too, so it can be charted
 * and aggregated. The metric keeps only the low-cardinality fields named in `keys`.
 *
 * @param {LogBrewClient} client
 * @param {LogBrewBrowserEvent<SpanAttributes>} span
 * @param {TimingMetric} metric
 * @returns {void}
 */
function recordTimingMetric(client, span, { keys, name, unit, value }) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < NO_DURATION) {
    return;
  }
  const source = span.attributes.metadata ?? {};
  /** @type {Metadata} */
  const metadata = {};
  for (const key of keys) {
    const field = source[key];
    if (field !== undefined) {
      metadata[key] = field;
    }
  }
  /** @type {MetricAttributes} */
  const attributes = { kind: "histogram", metadata, name, temporality: "delta", unit, value };
  client.metric(createAutomaticBrowserEventId("evt_browser_metric", name), span.timestamp, attributes);
}

export { REQUEST_METRIC_KEYS, recordTimingMetric };
