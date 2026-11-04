import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";

process.env.LOGBREW_RELEASE = "checkout@1.2.3";
process.env.LOGBREW_ENVIRONMENT = "production";
process.env.LOGBREW_SERVICE_NAME = "checkout-web";
process.env.NEXT_TELEMETRY_DISABLED = "1";
const next = createRequire(import.meta.url).resolve("next/dist/bin/next");

const build = spawnSync(process.execPath, [next, "build"], { stdio: "inherit" });
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}
const port = await new Promise((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port: free } = probe.address();
    probe.close(() => resolve(free));
  });
});
const server = spawn(process.execPath, [next, "start", "-H", "127.0.0.1", "-p", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve, reject) => {
  server.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    if (chunk.toString().includes("Ready")) {
      resolve();
    }
  });
  server.once("exit", reject);
});
const base = `http://127.0.0.1:${port}`;
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
for (const path of ["/api/checkout", "/api/fail", "/broken"]) {
  const response = await fetch(`${base}${path}`, { headers: { traceparent } });
  console.log(path, response.status);
  await response.text();
}
await new Promise((resolve) => setTimeout(resolve, 1500));
server.kill("SIGTERM");
await new Promise((resolve) => server.once("exit", resolve));
