# LogBrew SDK benchmarks

These scripts measure the LogBrew JavaScript SDKs. Two of them run LogBrew
and a widely used open-source error-tracking SDK on the same machine, with the
same workload and each SDK's default settings. They measure the browser bundle
size and the CPU time and memory each SDK spends on a captured error or span.
The third measures how fast the LogBrew API makes a log readable. You can
rerun all of them with one command and check every number below.

## Run them

You need Node.js 22 or newer and Google Chrome or Chromium.

```bash
bash benchmarks/run.sh
```

The script installs the exact package versions from `package-lock.json`, then
prints one JSON result for each benchmark. The size and cost benchmarks take
about 3 minutes, and the latency benchmark about 2 more. `--quick` runs a few
events only. CI uses it to check that the scripts still work, and it does not
check the results.

The latency benchmark sends logs to your own LogBrew project. It runs only when
you give it key files:

```bash
logbrew projects keys create "<project_id>" --kind server --ingest-key-file ./bench.ingest
logbrew projects keys create "<project_id>" --kind read --ingest-key-file ./bench.read
LOGBREW_INGEST_KEY_FILE=./bench.ingest LOGBREW_READ_KEY_FILE=./bench.read bash benchmarks/run.sh
```

The script reads the keys from the files and never prints them. Use a separate
project, because the run adds 100 logs to it. Revoke both keys when you finish.

## Results

All numbers come from runs on 2026-10-29. The raw output, with every
individual run, is in [results/2026-10-29](results/2026-10-29).

| Machine and software | Value |
| --- | --- |
| Computer | Apple M4, 10 cores, 16 GB memory |
| Operating system | macOS 27.0.1 |
| Node.js | 22.18.0 |
| Browser | Headless Chrome 156.0.8078.48 |
| Bundler | esbuild 0.28.2 |
| Machine load | Other programs ran during the cost runs. The load average went from about 8 to 26. |

| Packages | Version |
| --- | --- |
| LogBrew | `@logbrew/browser` 0.1.15, `@logbrew/node` 0.1.20, `@logbrew/sdk` 0.1.35 |
| Comparison SDK | `@sentry/browser` 11.10.0, `@sentry/node` 11.10.0 |
| Web Vitals, for the LogBrew tracing setup | `web-vitals` 6.2.3 |

We picked the comparison SDK because its browser package had the most weekly
npm downloads of the open-source error-tracking browser SDKs we checked. The
npm downloads API reported 41,639,917 downloads for it in the week from
2026-10-21 to 2026-10-27. We read that number on 2026-10-29.

### Browser bundle size with errors and tracing

| SDK | gzip | brotli |
| --- | ---: | ---: |
| LogBrew | 48,078 B | 41,192 B |
| Comparison SDK | 55,602 B | 48,757 B |

With gzip, the LogBrew bundle is 7,524 bytes smaller, or 13.5 percent. With
brotli, it is 7,565 bytes smaller, or 15.5 percent.

### SDK cost per captured event

Each row ran 15 times for each SDK, and the two SDKs took turns going first.
Each value is the median of those 15 runs, followed by the slowest or largest
run. One run captures 1,000 events, so each run's value is already an average
of 1,000 events. CPU time is in microseconds per event. Memory is what the SDK
allocated per event, in bytes, whether or not it was freed later.

| Runtime and event | LogBrew CPU | Comparison CPU | LogBrew memory | Comparison memory |
| --- | ---: | ---: | ---: | ---: |
| Node.js, error | 100.1 µs, max 170.6 | 144.0 µs, max 318.9 | 44,374 B, max 44,435 | 52,281 B, max 52,463 |
| Node.js, span | 48.0 µs, max 105.1 | 122.7 µs, max 256.4 | 15,834 B, max 15,918 | 46,330 B, max 47,307 |
| Browser, error | 57.1 µs, max 66.3 | 121.8 µs, max 145.9 | 29,903 B, max 29,993 | 52,766 B, max 52,868 |
| Browser, span | 20.7 µs, max 22.9 | 79.3 µs, max 86.1 | 9,238 B, max 9,294 | 19,049 B, max 19,526 |

LogBrew used less CPU time and less memory in every row, at the median and in
the slowest run. At the median, the comparison SDK used 1.4 times LogBrew's CPU
time for a Node.js error, the closest row, and 3.8 times for a browser span.

The Node.js runs share the machine's cores with other programs, so they vary
more than the browser runs.

### LogBrew ingest and query latency

| Measurement | p50 | p99 | Max | Samples |
| --- | ---: | ---: | ---: | ---: |
| Capture to accepted by the API | 260 ms | 415 ms | 424 ms | 100 |
| Capture to returned by the read API | 402 ms | 644 ms | 646 ms | 100 |
| One log search request | 132 ms | 207 ms | 230 ms | 100 |

These times include the network round trip between the benchmark computer and
`https://api.logbrew.co`. This benchmark has no comparison.

## Method

The rules for every benchmark were fixed before the first result, including
the 15 runs for each cost row. Each SDK runs with its default settings and the
same workload on the same machine. Every run counts. Nothing is a best of
several attempts.

### Bundle size

[size.mjs](size.mjs) bundles a small app for each SDK with esbuild: bundled,
minified, ES module output, browser platform, and no other options. It then
compresses each bundle with gzip at level 9 and brotli at quality 11. Sizes do
not change between runs, so the script builds each bundle once.

The LogBrew app in [size/logbrew-tracing.js](size/logbrew-tracing.js) captures
errors and turns on every tracing helper that the
[browser package README](../js/logbrew-browser/README.md) documents: route
changes, fetch and XHR spans with trace propagation, document load, resource
timing, interactions and long tasks, and Web Vitals through the `web-vitals`
package. The comparison app in
[size/comparison-tracing.js](size/comparison-tracing.js) uses that SDK's
documented tracing setup. Its browser tracing integration covers page loads,
navigations, fetch and XHR spans, long tasks, and Web Vitals.

### Cost per event

[overhead.mjs](overhead.mjs) replaces each SDK's network transport with an
in-memory stub, so no request leaves the computer. Both SDKs still build and
serialize every payload before they hand it to the stub. The Node.js runs use
a new process each time. The browser runs use a new Chrome browser context each
time. The order of the two SDKs alternates from run to run, so neither always
runs on a cooler machine.

Each run first captures 200 events to warm up. It then runs the same loop
twice, once without the SDK and once with it, and subtracts the first from the
second. So the result is the SDK's own cost, without the cost of creating each
`Error` in the app. Each event runs in its own task, the way errors and spans
arrive in an app, and the loop waits for the SDK to flush at the end.

- An error is a new `Error` with a unique message. LogBrew captures it with
  `captureBrowserError()` in the browser, and with `client.issue()` and
  `createIssueAttributesFromError()` in Node.js. The comparison SDK uses
  `captureException()`.
- A span is a root span around an empty function. LogBrew records it with
  `client.span()` after it creates a trace context, an event ID, and a
  duration. The comparison SDK uses `startSpan()` with `tracesSampleRate: 1.0`.
- Node.js CPU time is `process.cpuUsage()`, user plus system, for all threads
  of the process. Browser CPU time is the page's main-thread task time from the
  Chrome DevTools Protocol.
- Memory comes from the V8 sampling heap profiler at a 128-byte interval, with
  objects that garbage collection already freed included.
- After each run the script counts the delivered events in the stub. The run
  fails unless every captured error or span arrived.

The [overhead](overhead) folder has the adapter for each SDK and the shared
loop.

### Ingest and query latency

[latency.mjs](latency.mjs) uses `@logbrew/node` with its default transport. It
sends 100 logs one at a time, each with a unique marker.

- The clock starts just before `client.log()`. Accepted is when `flush()`
  returns a success response.
- After a log is accepted, the script searches for its marker with
  `GET /api/logs` and a read key. It repeats the search every 200 ms until the
  log appears. Readable is when that search response returns.
- When all 100 logs are readable, the script runs 100 more searches, 200 ms
  apart, for all logs of the run and times each request. The last search must
  return all 100 logs.
- A rate-limited request waits for `Retry-After`, and that wait counts in the
  result. This run had no rate-limited requests.

p50 and p99 use the nearest-rank method over all 100 samples.

## Limits

- One machine and one date. Your numbers will differ, so rerun the scripts on
  your own hardware.
- The cost benchmark measures capture and serialization with a stub transport.
  It does not measure network time in your app.
- With 15 runs, the cost table reports the median and the maximum of the runs.
  15 runs are too few for a p99.
- The latency results depend on the network path from the benchmark computer to
  the API.
