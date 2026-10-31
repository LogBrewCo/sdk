import { firstPreviewEvent, invokeUnchecked, sampleClient } from "./batch-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { LogBrewClient } from "@logbrew/sdk"
 */

const METRIC_ID = "evt_metric_001";
const TIMESTAMP = "2026-06-02T10:00:06Z";
const QUEUE_DEPTH_DELTA = -3;
const NEGATIVE_COUNT = -1;
const QUEUE_DEPTH = 3;
const OVERLONG_DESCRIPTION_LENGTH = 1025;
const INVALID_DESCRIPTIONS = [
  null,
  "",
  "   ",
  "M".repeat(OVERLONG_DESCRIPTION_LENGTH),
  "request\u0085count",
  "request\u2028count",
  "request\uD800count"
];

/**
 * @param {LogBrewClient} client
 * @param {unknown} attributes
 * @param {Readonly<RegExp>} pattern
 * @returns {void}
 */
function assertMetricRejected(client, attributes, pattern) {
  assert.throws(() => invokeUnchecked(client, "metric", [METRIC_ID, TIMESTAMP, attributes]), pattern);
}

await test("metric helper validates explicit metric attributes", () => {
  const client = sampleClient();
  client.metric(METRIC_ID, TIMESTAMP, {
    description: "Number of items waiting in the checkout queue.",
    kind: "gauge",
    metadata: { service: "checkout" },
    name: "queue.depth",
    temporality: "instant",
    unit: "{item}",
    value: QUEUE_DEPTH_DELTA
  });

  assert.deepEqual(firstPreviewEvent(client), {
    attributes: {
      description: "Number of items waiting in the checkout queue.",
      kind: "gauge",
      metadata: { service: "checkout" },
      name: "queue.depth",
      temporality: "instant",
      unit: "{item}",
      value: QUEUE_DEPTH_DELTA
    },
    id: METRIC_ID,
    timestamp: TIMESTAMP,
    type: "metric"
  });
});

await test("metric helper rejects unsafe values", () => {
  const client = sampleClient();
  assertMetricRejected(client, {
    kind: "counter",
    name: "checkout.requests",
    temporality: "delta",
    unit: "{request}",
    value: Number.NaN
  }, /metric value must be a finite number/u);
  assertMetricRejected(client, {
    kind: "counter",
    name: "checkout.requests",
    temporality: "delta",
    unit: "{request}",
    value: NEGATIVE_COUNT
  }, /metric counter value must be non-negative/u);
  assertMetricRejected(client, {
    kind: "gauge",
    name: "checkout.queue_depth",
    temporality: "delta",
    unit: "{item}",
    value: QUEUE_DEPTH
  }, /metric temporality for gauge must be one of: instant/u);
  for (const description of INVALID_DESCRIPTIONS) {
    assertMetricRejected(client, {
      description,
      kind: "gauge",
      name: "checkout.queue_depth",
      temporality: "instant",
      unit: "{item}",
      value: QUEUE_DEPTH
    }, /metric description must be a non-blank string of at most 1024 non-control characters/u);
  }
});
