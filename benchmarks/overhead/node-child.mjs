import { Session } from "node:inspector/promises";
import { runLoop } from "./loop.js";
import { setImmediate } from "node:timers/promises";

/**
 * @import { Bench, LoopRun, Signal } from "./loop.js"
 * @typedef {{ readonly children: readonly SampledNode[], readonly selfSize: number }} SampledNode
 */

const FIRST_ARGUMENT = 2;
const HEAP_SAMPLING_INTERVAL_BYTES = 128;
const NO_BYTES = 0;
const [adapterName = "", signalText = "", countText = "", warmupText = ""] = process.argv.slice(FIRST_ARGUMENT);
const count = Number(countText);
const warmup = Number(warmupText);
const session = new Session();
const progress = { delivered: 0, offset: 0 };

/**
 * @returns {Promise<Bench>}
 */
async function loadBench() {
  if (adapterName === "logbrew") {
    const { bench } = await import("./logbrew-node.mjs");
    return bench;
  }
  if (adapterName === "comparison") {
    const { bench } = await import("./comparison-node.mjs");
    return bench;
  }
  throw new TypeError(`unknown adapter ${adapterName}`);
}

/**
 * @param {SampledNode} node
 * @returns {number}
 */
function sampled(node) {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampled(child), NO_BYTES);
}

/**
 * @returns {number}
 */
function cpuMicros() {
  const usage = process.cpuUsage();
  return usage.user + usage.system;
}

/**
 * @returns {Promise<void>}
 */
async function nextTask() {
  await setImmediate();
}

/**
 * @param {Signal} signal
 * @param {number} events
 * @param {boolean} withSdk
 * @returns {LoopRun}
 */
function nextRun(signal, events, withSdk) {
  const run = { count: events, offset: progress.offset, signal, withSdk };
  progress.offset += events;
  if (withSdk) {
    progress.delivered += events;
  }
  return run;
}

/**
 * @param {Bench} bench
 * @param {Signal} signal
 * @param {boolean} withSdk
 * @returns {Promise<number>}
 */
async function allocated(bench, signal, withSdk) {
  await session.post("HeapProfiler.startSampling", {
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
    samplingInterval: HEAP_SAMPLING_INTERVAL_BYTES
  });
  await runLoop(bench, nextTask, nextRun(signal, count, withSdk));
  const { profile } = await session.post("HeapProfiler.stopSampling");
  return sampled(profile.head);
}

if (signalText !== "error" && signalText !== "span") {
  throw new TypeError("Usage: node node-child.mjs <logbrew|comparison> <error|span> <count> <warmup>");
}
const signal = signalText;
const bench = await loadBench();
session.connect();
await session.post("HeapProfiler.enable");
bench.init(signal);
await runLoop(bench, nextTask, nextRun(signal, warmup, true));
const cpuBefore = cpuMicros();
await runLoop(bench, nextTask, nextRun(signal, count, false));
const cpuBaseline = cpuMicros();
await runLoop(bench, nextTask, nextRun(signal, count, true));
const cpuWithSdk = cpuMicros();
const baselineBytes = await allocated(bench, signal, false);
const sdkBytes = await allocated(bench, signal, true);
session.disconnect();
process.stdout.write(
  `${JSON.stringify({
    bytesPerEvent: (sdkBytes - baselineBytes) / count,
    cpuMicrosPerEvent: (cpuWithSdk - cpuBaseline - (cpuBaseline - cpuBefore)) / count,
    delivered: bench.delivered(signal),
    expected: progress.delivered
  })}\n`
);
