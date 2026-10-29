// Runs one Node.js measurement in a fresh process and prints one JSON line.
// Usage: node node-child.mjs logbrew <error|span> <count> <warmup>
import { Session } from "node:inspector/promises";
import { runLoop } from "./loop.js";

const [sdk, signal, countText, warmupText] = process.argv.slice(2);
const count = Number(countText);
const warmup = Number(warmupText);
const bench = (await import(`./${sdk}-node.mjs`)).default;
const nextTask = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });
const cpuMicros = () => {
  const usage = process.cpuUsage();
  return usage.user + usage.system;
};
const session = new Session();
session.connect();
await session.post("HeapProfiler.enable");
const sampled = (node) => node.selfSize + node.children.reduce((sum, child) => sum + sampled(child), 0);
async function allocated(withSdk, offset) {
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 128,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true
  });
  await runLoop(bench, signal, count, offset, nextTask, withSdk);
  const { profile } = await session.post("HeapProfiler.stopSampling");
  return sampled(profile.head);
}

bench.init(signal);
await runLoop(bench, signal, warmup, 0, nextTask, true);
const cpu0 = cpuMicros();
await runLoop(bench, signal, count, warmup, nextTask, false);
const cpu1 = cpuMicros();
await runLoop(bench, signal, count, warmup + count, nextTask, true);
const cpu2 = cpuMicros();
const baselineBytes = await allocated(false, warmup + 2 * count);
const sdkBytes = await allocated(true, warmup + 3 * count);
console.log(JSON.stringify({
  cpuMicrosPerEvent: (cpu2 - cpu1 - (cpu1 - cpu0)) / count,
  bytesPerEvent: (sdkBytes - baselineBytes) / count,
  delivered: bench.delivered(signal),
  expected: warmup + 2 * count
}));
process.exit(0);
