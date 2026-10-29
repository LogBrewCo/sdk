// Measures SDK cost per captured error and per span, with each SDK's transport replaced by an
// in-memory stub, in Node.js and in headless Chrome. Every run starts a fresh Node.js process
// or a fresh Chrome browser context. Prints every run and the median and maximum per case.
// Usage: node overhead.mjs [--quick]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { build } from "esbuild";
import { launchChrome } from "./overhead/cdp.mjs";

const quick = process.argv.includes("--quick");
// Fixed before any result was seen. --quick only checks that the benchmark still runs.
const RUNS = quick ? 1 : 15;
const COUNT = quick ? 50 : 1000;
const WARMUP = quick ? 10 : 200;
const SDKS = ["logbrew", "sentry"];
// The adapter files in overhead/ for each SDK.
const ADAPTERS = { logbrew: "logbrew", sentry: "comparison" };
const SIGNALS = ["error", "span"];
const here = new URL(".", import.meta.url).pathname;
const version = (name) => JSON.parse(readFileSync(`${here}node_modules/${name}/package.json`, "utf8")).version;

async function bundle(sdk) {
  const result = await build({
    stdin: {
      contents: `import "./overhead/${ADAPTERS[sdk]}-browser.js";
import { runLoop } from "./overhead/loop.js";
const channel = new MessageChannel();
const nextTask = () => new Promise((resolve) => { channel.port1.onmessage = resolve; channel.port2.postMessage(0); });
globalThis.measure = (signal, count, offset, withSdk) => runLoop(globalThis.bench, signal, count, offset, nextTask, withSdk);`,
      resolveDir: here,
      loader: "js"
    },
    bundle: true,
    minify: true,
    format: "iife",
    platform: "browser",
    write: false,
    logLevel: "silent"
  });
  return result.outputFiles[0].text;
}

function nodeRun(sdk, signal) {
  const output = execFileSync(process.execPath, [`${here}overhead/node-child.mjs`, ADAPTERS[sdk], signal, String(COUNT), String(WARMUP)], {
    cwd: here,
    encoding: "utf8"
  });
  return JSON.parse(output.trim().split("\n").pop());
}

async function browserRun(chrome, origin, sdk, signal) {
  const { send, waitFor } = chrome;
  const { browserContextId } = await send("Target.createBrowserContext");
  const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const call = async (expression) => {
    const { result, exceptionDetails } = await send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    );
    if (exceptionDetails) {
      throw new Error(`${sdk} ${signal}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    }
    return result.value;
  };
  const taskSeconds = async () =>
    (await send("Performance.getMetrics", {}, sessionId)).metrics.find((metric) => metric.name === "TaskDuration").value;
  const allocated = async (expression) => {
    await send("HeapProfiler.startSampling", {
      samplingInterval: 128,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true
    }, sessionId);
    await call(expression);
    const { profile } = await send("HeapProfiler.stopSampling", {}, sessionId);
    const sampled = (node) => node.selfSize + node.children.reduce((sum, child) => sum + sampled(child), 0);
    return sampled(profile.head);
  };
  await send("Page.enable", {}, sessionId);
  await send("Performance.enable", {}, sessionId);
  await send("HeapProfiler.enable", {}, sessionId);
  const loaded = waitFor("Page.loadEventFired", sessionId);
  await send("Page.navigate", { url: `${origin}/${sdk}.html` }, sessionId);
  await loaded;
  const measure = (count, offset, withSdk) => `measure(${JSON.stringify(signal)}, ${count}, ${offset}, ${withSdk})`;
  await call(`bench.init(${JSON.stringify(signal)})`);
  await call(measure(WARMUP, 0, true));
  const t0 = await taskSeconds();
  await call(measure(COUNT, WARMUP, false));
  const t1 = await taskSeconds();
  await call(measure(COUNT, WARMUP + COUNT, true));
  const t2 = await taskSeconds();
  const baselineBytes = await allocated(measure(COUNT, WARMUP + 2 * COUNT, false));
  const sdkBytes = await allocated(measure(COUNT, WARMUP + 3 * COUNT, true));
  const delivered = await call(`bench.delivered(${JSON.stringify(signal)})`);
  await send("Target.disposeBrowserContext", { browserContextId });
  return {
    cpuMicrosPerEvent: ((t2 - t1 - (t1 - t0)) * 1e6) / COUNT,
    bytesPerEvent: (sdkBytes - baselineBytes) / COUNT,
    delivered,
    expected: WARMUP + 2 * COUNT
  };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value) => Math.round(value * 10) / 10;

const bundles = Object.fromEntries(await Promise.all(SDKS.map(async (sdk) => [sdk, await bundle(sdk)])));
const server = createServer((request, response) => {
  const [, name, extension] = request.url.match(/^\/(\w+)\.(html|js)$/) ?? [];
  if (!bundles[name]) {
    response.writeHead(404).end();
  } else if (extension === "html") {
    response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>bench</title><script src="/${name}.js"></script>`);
  } else {
    response.writeHead(200, { "content-type": "text/javascript" }).end(bundles[name]);
  }
});
await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = await launchChrome();
const chromeVersion = (await chrome.send("Browser.getVersion")).product;

const cases = [];
try {
  for (const runtime of ["node", "browser"]) {
    for (const signal of SIGNALS) {
      const runs = { logbrew: [], sentry: [] };
      for (let run = 0; run < RUNS; run += 1) {
        // Alternate which SDK goes first so that neither always runs on a cooler machine.
        for (const sdk of run % 2 === 0 ? SDKS : [...SDKS].reverse()) {
          const result = runtime === "node" ? nodeRun(sdk, signal) : await browserRun(chrome, origin, sdk, signal);
          if (result.delivered !== result.expected) {
            throw new Error(`${runtime} ${sdk} ${signal}: delivered ${result.delivered} of ${result.expected} events`);
          }
          runs[sdk].push(result);
        }
      }
      for (const sdk of SDKS) {
        const cpu = runs[sdk].map((result) => result.cpuMicrosPerEvent);
        const bytes = runs[sdk].map((result) => result.bytesPerEvent);
        cases.push({
          runtime,
          signal,
          sdk,
          package: runtime === "node"
            ? (sdk === "logbrew" ? `@logbrew/node@${version("@logbrew/node")}` : `@sentry/node@${version("@sentry/node")}`)
            : (sdk === "logbrew" ? `@logbrew/browser@${version("@logbrew/browser")}` : `@sentry/browser@${version("@sentry/browser")}`),
          cpuMicrosPerEvent: { median: round(median(cpu)), max: round(Math.max(...cpu)), runs: cpu.map(round) },
          bytesPerEvent: { median: Math.round(median(bytes)), max: Math.round(Math.max(...bytes)), runs: bytes.map(Math.round) }
        });
      }
    }
  }
} finally {
  await chrome.close();
  server.close();
}

console.log(JSON.stringify({
  benchmark: "sdk-overhead-per-event",
  runs: RUNS,
  eventsPerRun: COUNT,
  warmupEvents: WARMUP,
  node: process.version,
  chrome: chromeVersion,
  cases
}, null, 2));
