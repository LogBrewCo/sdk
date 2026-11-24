import test, { after } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true }))));

async function installBrowserPackage() {
  const tempDir = await mkdtemp(join(tmpdir(), "logbrew-browser-extension-frames-test-"));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, "node_modules", "@logbrew"), { recursive: true });
  await cp(resolve(repoRoot, "js/logbrew-js"), join(tempDir, "node_modules", "@logbrew", "sdk"), { recursive: true });
  await cp(resolve(repoRoot, "js/logbrew-browser"), join(tempDir, "node_modules", "@logbrew", "browser"), { recursive: true });
  return {
    esm: await import(pathToFileURL(join(tempDir, "node_modules", "@logbrew", "browser", "index.js"))),
    cjs: createRequire(join(tempDir, "package.json"))("@logbrew/browser")
  };
}

function createWindow() {
  return {
    console: { debug() {}, error() {}, info() {}, log() {}, warn() {} },
    location: { href: "https://shop.example.test/cart", pathname: "/cart" },
    navigator: { userAgent: "test" },
    addEventListener() {},
    removeEventListener() {}
  };
}

async function sentIssue({ captureBrowserError, installLogBrewBrowser }, stack) {
  const context = installLogBrewBrowser({ browserWindow: createWindow(), clientKey: "LOGBREW_BROWSER_KEY", flushOnCapture: false });
  const error = new TypeError("Cannot read properties of undefined (reading 'id')");
  error.stack = stack;
  await captureBrowserError(error, context, { flushOnCapture: false });
  return JSON.parse(context.client.previewJson()).events.find((event) => event.type === "issue");
}

const extensionStacks = [
  {
    frame: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/200.js",
    stack: [
      "TypeError: Cannot read properties of undefined (reading 'id')",
      "    at readId (chrome-extension://abcdefghijklmnopabcdefghijklmnop/200.js:1:2345)"
    ].join("\n")
  },
  {
    frame: "moz-extension://11111111-2222-4333-8444-555555555555/200.js",
    stack: "readId@moz-extension://11111111-2222-4333-8444-555555555555/200.js:1:2345"
  }
];

test("errors thrown by browser extension scripts keep the extension URL in the sent frame", async () => {
  const modules = await installBrowserPackage();
  for (const [format, browserPackage] of Object.entries(modules)) {
    for (const { frame, stack } of extensionStacks) {
      const issue = await sentIssue(browserPackage, stack);
      assert.equal(issue.attributes.stackFrames[0].filename, frame, `${format} stack frame`);
      assert.equal(issue.attributes.metadata.errorFrameFile, frame, `${format} error frame file`);
      assert.equal(issue.attributes.metadata.issueGroupingKey, `browser.error:TypeError:${frame}`, `${format} grouping key`);
    }
  }
});

test("errors thrown by page scripts keep only the script path", async () => {
  const modules = await installBrowserPackage();
  for (const [format, browserPackage] of Object.entries(modules)) {
    const issue = await sentIssue(browserPackage, [
      "TypeError: Cannot read properties of undefined (reading 'id')",
      "    at readId (https://shop.example.test/assets/app.js?v=3#top:4:5)",
      "    at load (/home/example/site/vendor.js:6:7)"
    ].join("\n"));
    assert.deepEqual(
      issue.attributes.stackFrames.map((frame) => frame.filename),
      ["/assets/app.js", "vendor.js"],
      `${format} stack frames`
    );
  }
});
