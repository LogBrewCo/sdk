import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { readField } from "./fields.js";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

/**
 * @typedef {(method: string, params: Readonly<Record<string, unknown>>, sessionId?: string) => Promise<unknown>} Send
 * @typedef {(method: string, sessionId: string) => Promise<unknown>} WaitFor
 * @typedef {{ readonly close: () => Promise<void>, readonly send: Send, readonly waitFor: WaitFor }} Chrome
 * @typedef {(message: unknown) => void} Listener
 * @typedef {{ readonly reject: (error: Readonly<Error>) => void, readonly resolve: (result: unknown) => void }} Waiter
 */

const PORT_POLL_ATTEMPTS = 200;
const PORT_POLL_MS = 50;
const ID_STEP = 1;
const candidates = [
  process.env["CHROME_PATH"] ?? "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter((candidate) => candidate !== "");

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<string>}
 */
async function findChrome() {
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  throw new Error("Chrome not found. Set CHROME_PATH.");
}

/**
 * @param {string} profile
 * @returns {Promise<string>}
 */
async function readDebuggerUrl(profile) {
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < PORT_POLL_ATTEMPTS && !(await exists(portFile)); attempt += ID_STEP) {
    await sleep(PORT_POLL_MS);
  }
  const portText = await readFile(portFile, "utf8");
  const [port = "", debuggerPath = ""] = portText.trim().split("\n");
  return `ws://127.0.0.1:${port}${debuggerPath}`;
}

/**
 * @param {Waiter | undefined} waiter
 * @param {unknown} message
 * @returns {void}
 */
function settle(waiter, message) {
  const error = readField(message, "error");
  if (error === undefined) {
    waiter?.resolve(readField(message, "result"));
    return;
  }
  const reason = String(readField(error, "message"));
  waiter?.reject(new Error(reason));
}

/**
 * @returns {{ readonly dispatch: Listener, readonly request: () => { readonly id: number, readonly reply: Promise<unknown> }, readonly waitFor: WaitFor }}
 */
function createProtocol() {
  /** @type {Map<number, Waiter>} */
  const pending = new Map();
  /** @type {Set<Listener>} */
  const listeners = new Set();
  const ids = { next: 0 };
  return {
    dispatch(message) {
      const id = readField(message, "id");
      if (typeof id === "number") {
        settle(pending.get(id), message);
        pending.delete(id);
        return;
      }
      for (const listener of listeners) {
        listener(message);
      }
    },
    request() {
      ids.next += ID_STEP;
      /** @type {PromiseWithResolvers<unknown>} */
      const reply = Promise.withResolvers();
      pending.set(ids.next, reply);
      return { id: ids.next, reply: reply.promise };
    },
    async waitFor(method, sessionId) {
      /** @type {PromiseWithResolvers<unknown>} */
      const event = Promise.withResolvers();
      /** @type {Listener} */
      function listener(message) {
        if (readField(message, "method") === method && readField(message, "sessionId") === sessionId) {
          listeners.delete(listener);
          event.resolve(readField(message, "params"));
        }
      }
      listeners.add(listener);
      return event.promise;
    }
  };
}

/**
 * @param {string} url
 * @returns {Promise<{ readonly close: () => void, readonly send: Send, readonly waitFor: WaitFor }>}
 */
async function connect(url) {
  const socket = new WebSocket(url);
  const { dispatch, request, waitFor } = createProtocol();
  socket.addEventListener("message", (event) => {
    /** @type {unknown} */
    const message = JSON.parse(String(event.data));
    dispatch(message);
  });
  /** @type {PromiseWithResolvers<void>} */
  const open = Promise.withResolvers();
  socket.addEventListener("open", () => {
    open.resolve();
  });
  socket.addEventListener("error", () => {
    open.reject(new Error("Chrome DevTools connection failed"));
  });
  await open.promise;
  return {
    close() {
      socket.close();
    },
    async send(method, params, sessionId) {
      const { id, reply } = request();
      socket.send(JSON.stringify({ id, method, params, sessionId }));
      return reply;
    },
    waitFor
  };
}

/**
 * @returns {Promise<Chrome>}
 */
async function launchChrome() {
  const executable = await findChrome();
  const profile = await mkdtemp(path.join(tmpdir(), "logbrew-bench-chrome-"));
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      "about:blank"
    ],
    { stdio: "ignore" }
  );
  const { close, send, waitFor } = await connect(await readDebuggerUrl(profile));
  return {
    async close() {
      close();
      const exited = once(child, "exit");
      child.kill();
      await exited;
      await rm(profile, { force: true, recursive: true });
    },
    send,
    waitFor
  };
}

export { launchChrome };
