import random from "./index-random.cjs";
import { readField } from "./native-diagnostics-values.js";

/**
 * @import { LogBrewClient } from "@logbrew/sdk"
 */

const MAX_APP_START_MS = 60_000;

/** @type {Promise<number>} */
const firstFrameAt = new Promise((resolve) => {
  const markFrame = () => {
    resolve(Date.now());
  };
  const requestFrame = readField(globalThis, "requestAnimationFrame");
  if (typeof requestFrame === "function") {
    Reflect.apply(requestFrame, globalThis, [markFrame]);
  } else {
    setTimeout(markFrame, 0);
  }
});
let claimed = false;

/**
 * @param {LogBrewClient} client
 * @param {unknown} nativeRuntime
 * @param {number} frameAt
 */
function sendAppStartMetric(client, nativeRuntime, frameAt) {
  const processStartTime = readField(nativeRuntime, "processStartTime");
  /** @type {unknown} */
  const startedAt = typeof processStartTime === "function" ? Reflect.apply(processStartTime, nativeRuntime, []) : undefined;
  if (typeof startedAt !== "number" || startedAt <= 0) {
    return;
  }
  const durationMs = frameAt - startedAt;
  if (!(durationMs >= 0 && durationMs <= MAX_APP_START_MS)) {
    return;
  }
  client.metric(random.defaultEventId("app_start"), new Date(frameAt).toISOString(), {
    name: "app.start.duration",
    description: "Time from process start to the first frame.",
    kind: "histogram",
    value: durationMs,
    unit: "ms",
    temporality: "delta",
    metadata: { startType: "cold" }
  });
}

/**
 * Sends one cold start metric per process after the first frame.
 *
 * @param {LogBrewClient} client
 * @param {unknown} nativeRuntime
 */
function captureAppStart(client, nativeRuntime) {
  if (claimed) {
    return;
  }
  claimed = true;
  firstFrameAt.then((frameAt) => {
    sendAppStartMetric(client, nativeRuntime, frameAt);
  }).catch(() => undefined);
}

export { captureAppStart };
