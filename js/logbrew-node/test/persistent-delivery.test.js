import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

import { RecordingTransport } from "@logbrew/sdk";
import {
  createLogBrewNodeClient,
  purgeLogBrewNodePersistentQueue
} from "../index.js";

const CHILD_NAME = "logbrew-node-queue-v1";
const FIXED_TIMESTAMP = "2026-07-21T10:00:00Z";
const SOURCE_MODULE_URL = new URL("../index.js", import.meta.url).href;
const require = createRequire(import.meta.url);
const fsModule = require("node:fs");
const timersModule = require("node:timers");
const persistentQueueModulePath = require.resolve("../persistent-queue.cjs");

function temporaryParent(t) {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "logbrew-node-persistent-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

function queueDirectory(parent) {
  return join(parent, CHILD_NAME);
}

function createClient(parent, overrides = {}) {
  return createLogBrewNodeClient({
    apiKey: "TEST_API_KEY",
    persistentQueuePath: parent,
    ...overrides
  });
}

function capture(client, id, message = "queued") {
  client.log(id, FIXED_TIMESTAMP, { level: "info", message });
}

function eventFiles(parent) {
  return readdirSync(queueDirectory(parent))
    .filter((name) => /^event-[0-9]{16}\.json$/.test(name))
    .sort();
}

function payloadEventIds(bodies) {
  return bodies.flatMap((body) => JSON.parse(body).events.map((event) => event.id));
}

function storedEvent(id) {
  return JSON.stringify({
    type: "log",
    id,
    timestamp: FIXED_TIMESTAMP,
    attributes: { message: "stored", level: "info" }
  });
}

function queueConfig(parent) {
  return {
    batchPrefixBytes: 0,
    batchSuffixBytes: 0,
    maxBatchBytes: 256 * 1024,
    maxQueueBytes: 4 * 1024 * 1024,
    maxQueueSize: 1000,
    persistentQueuePath: parent,
    restoreEvent: JSON.parse
  };
}

function queueRecord(id) {
  const serialized = storedEvent(id);
  return {
    byteCount: Buffer.byteLength(serialized, "utf8"),
    event: JSON.parse(serialized),
    serialized
  };
}

function injectedIoError() {
  return Object.assign(new Error("injected filesystem failure"), { code: "EIO" });
}

function loadPersistentQueueWith({ filesystem = {}, timers = {} }) {
  const replacements = [
    ...Object.entries(filesystem).map(([name, replacement]) => [fsModule, name, replacement]),
    ...Object.entries(timers).map(([name, replacement]) => [timersModule, name, replacement])
  ];
  const originals = replacements.map(([target, name]) => [target, name, target[name]]);
  delete require.cache[persistentQueueModulePath];
  try {
    for (const [target, name, replacement] of replacements) {
      target[name] = replacement;
    }
    return require(persistentQueueModulePath);
  } finally {
    for (const [target, name, original] of originals) {
      target[name] = original;
    }
    delete require.cache[persistentQueueModulePath];
  }
}

async function captureRejection(callback) {
  try {
    await callback();
  } catch (error) {
    return error;
  }
  throw new Error("expected callback to reject");
}

function captureThrown(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("expected callback to throw");
}

function assertFixedStorageError(error, code) {
  assert.equal(error?.code, code);
  assert.match(error?.message ?? "", /^persistent queue [a-z ]+$/);
  assert.doesNotMatch(error.message, /[/\\]|TEST_API_KEY|https?:|event-/);
}

test("default Node client remains memory-only", async () => {
  const client = createLogBrewNodeClient({ apiKey: "TEST_API_KEY" });
  capture(client, "memory-default");

  assert.equal(client.pendingEvents(), 1);
  assert.equal(client.deliveryHealth().storage, "memory");
  assert.equal(client.deliveryHealth().hydratedEvents, 0);
  assert.equal((await client.flush(RecordingTransport.alwaysAccept())).statusCode, 202);
});

test("persistent queue factory participates in automatic delivery, health, purge, and shutdown", async (t) => {
  const parent = temporaryParent(t);
  let resolveSent;
  const sent = new Promise((resolve) => {
    resolveSent = resolve;
  });
  const client = createClient(parent, {
    deliveryIntervalMs: 60_000,
    deliveryQueueThreshold: 1,
    transport: {
      async send() {
        resolveSent();
        return { statusCode: 202, attempts: 1 };
      }
    }
  });

  assert.equal(client.deliveryHealth().storage, "persistent");
  assert.equal(client.deliveryHealth().hydratedEvents, 0);
  capture(client, "automatic-persistent");
  await sent;
  for (let attempt = 0; attempt < 100 && client.pendingEvents() !== 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(client.pendingEvents(), 0);
  assert.equal(client.deliveryHealth().lastOutcome, "accepted");
  await client.shutdown();

  const manual = createClient(parent, {
    automaticDelivery: false,
    transport: RecordingTransport.alwaysAccept()
  });
  capture(manual, "purged-persistent");
  assert.equal(manual.purgePendingEvents(), 1);
  assert.equal(manual.pendingEvents(), 0);
  await manual.shutdown();
});

test("encrypted and path persistence modes are mutually exclusive", () => {
  assert.throws(
    () => createLogBrewNodeClient({
      apiKey: "TEST_API_KEY",
      persistentQueue: {},
      persistentQueuePath: "/tmp/logbrew-mutually-exclusive-test"
    }),
    /persistentQueue and persistentQueuePath are mutually exclusive/
  );
});

test("CommonJS exposes the same opt-in persistence lifecycle", async (t) => {
  const parent = temporaryParent(t);
  const commonJs = require("../index.cjs");
  const client = commonJs.createLogBrewNodeClient({
    apiKey: "COMMONJS_KEY",
    persistentQueuePath: parent
  });
  capture(client, "commonjs-persisted");

  assert.equal(client.pendingEvents(), 1);
  await client.shutdown(RecordingTransport.alwaysAccept());
  assert.equal(commonJs.purgeLogBrewNodePersistentQueue({ persistentQueuePath: parent }), true);
});

test("persistent admission is atomic, owner-only, bounded, and content-minimal", async (t) => {
  const parent = temporaryParent(t);
  const client = createClient(parent, { maxQueueSize: 1 });

  capture(client, "persisted-first", "marker-body");
  capture(client, "persisted-dropped", "not-retained");

  assert.equal(client.pendingEvents(), 1);
  assert.equal(client.droppedEvents(), 1);
  assert.equal(eventFiles(parent).length, 1);
  assert.equal(lstatSync(queueDirectory(parent)).mode & 0o777, 0o700);
  const record = join(queueDirectory(parent), eventFiles(parent)[0]);
  assert.equal(lstatSync(record).mode & 0o777, 0o600);
  assert.equal(lstatSync(record).nlink, 1);
  assert.equal(JSON.parse(readFileSync(record, "utf8")).id, "persisted-first");

  const diskText = readdirSync(queueDirectory(parent), { recursive: true })
    .map((entry) => {
      const path = join(queueDirectory(parent), entry);
      return lstatSync(path).isFile() ? readFileSync(path, "utf8") : "";
    })
    .join("\n");
  assert.doesNotMatch(diskText, /TEST_API_KEY|api\.logbrew|authorization|process\.pid/);
  assert.doesNotMatch(readdirSync(queueDirectory(parent)).join("\n"), /persisted-first/);

  await client.shutdown(RecordingTransport.alwaysAccept());
});

test("persistent queue preserves UTF-8 byte limits without memory fallback", async (t) => {
  const parent = temporaryParent(t);
  const probe = createClient(parent);
  capture(probe, "utf8-probe", "tea \u2615");
  const exactBytes = probe.pendingBytes();
  await probe.shutdown(RecordingTransport.alwaysAccept());
  purgeLogBrewNodePersistentQueue({ persistentQueuePath: parent });

  const client = createClient(parent, { maxQueueBytes: exactBytes });
  capture(client, "utf8-first", "tea \u2615");
  capture(client, "utf8-second", "tea \u2615");

  assert.equal(client.pendingEvents(), 1);
  assert.equal(client.pendingBytes(), exactBytes);
  assert.equal(client.droppedEvents(), 1);
  await client.shutdown(RecordingTransport.alwaysAccept());
});

test("failed batches remain byte-identical and accepted prefixes alone are removed", async (t) => {
  const parent = temporaryParent(t);
  const client = createClient(parent, { maxBatchEvents: 2, maxRetries: 0 });
  for (let index = 0; index < 5; index += 1) {
    capture(client, `prefix-${index}`);
  }

  const firstTransport = new RecordingTransport([{ statusCode: 202 }, { statusCode: 503 }]);
  const failure = await captureRejection(() => client.flush(firstTransport));
  assert.equal(failure.code, "transport_error");
  assert.equal(client.pendingEvents(), 3);
  assert.equal(eventFiles(parent).length, 3);

  const retryTransport = RecordingTransport.alwaysAccept();
  const response = await client.flush(retryTransport);
  assert.equal(response.batches, 2);
  assert.deepEqual(payloadEventIds(retryTransport.sentBodies), ["prefix-2", "prefix-3", "prefix-4"]);
  assert.equal(firstTransport.sentBodies[1], retryTransport.sentBodies[0]);
  await client.shutdown(RecordingTransport.alwaysAccept());
});

test("capture during persistent I/O remains behind the frozen prefix", async (t) => {
  const parent = temporaryParent(t);
  const client = createClient(parent);
  capture(client, "snapshot-first");
  let releaseSend;
  const sendBlocked = new Promise((resolvePromise) => {
    releaseSend = resolvePromise;
  });
  let notifyStarted;
  const started = new Promise((resolvePromise) => {
    notifyStarted = resolvePromise;
  });
  const bodies = [];
  const transport = {
    async send(_apiKey, body) {
      bodies.push(body);
      notifyStarted();
      await sendBlocked;
      return { statusCode: 202, attempts: 1 };
    }
  };

  const flushing = client.flush(transport);
  await started;
  capture(client, "snapshot-later");
  releaseSend();
  await flushing;

  assert.deepEqual(payloadEventIds(bodies), ["snapshot-first"]);
  assert.equal(client.pendingEvents(), 1);
  assert.equal(JSON.parse(client.previewJson()).events[0].id, "snapshot-later");
  await client.shutdown(RecordingTransport.alwaysAccept());
});

test("failed shutdown reopens the intact persistent remainder", async (t) => {
  const parent = temporaryParent(t);
  const client = createClient(parent, { maxRetries: 0 });
  capture(client, "shutdown-first");

  const failure = await captureRejection(() => client.shutdown(new RecordingTransport([{ statusCode: 500 }])));
  assert.equal(failure.code, "transport_error");
  capture(client, "shutdown-later");
  assert.equal(client.pendingEvents(), 2);

  const accepted = RecordingTransport.alwaysAccept();
  await client.shutdown(accepted);
  assert.deepEqual(payloadEventIds(accepted.sentBodies), ["shutdown-first", "shutdown-later"]);

  const reopened = createClient(parent);
  assert.equal(reopened.pendingEvents(), 0);
  await reopened.shutdown(RecordingTransport.alwaysAccept());
});

test("failed lease release preserves the active heartbeat and usable owner", (t) => {
  const parent = temporaryParent(t);
  const nativeUnlink = fsModule.unlinkSync;
  let failRelease = false;
  let heartbeat;
  let clearedHeartbeats = 0;
  const persistentQueue = loadPersistentQueueWith({
    filesystem: {
      unlinkSync(path) {
        if (failRelease && path.includes("/.owner/lease-")) {
          failRelease = false;
          throw injectedIoError();
        }
        return nativeUnlink(path);
      }
    },
    timers: {
      clearInterval() {
        clearedHeartbeats += 1;
      },
      setInterval(callback) {
        heartbeat = callback;
        return { unref() {} };
      }
    }
  });
  const queue = persistentQueue.createPersistentEventQueue(queueConfig(parent));

  failRelease = true;
  assertFixedStorageError(captureThrown(() => queue.close()), "persistent_queue_unavailable");
  assert.equal(clearedHeartbeats, 0);
  heartbeat();
  queue.append(queueRecord("after-release-failure"));
  assert.equal(queue.length(), 1);

  queue.close();
  assert.equal(clearedHeartbeats, 1);
});

test("persistent admission resolves each injected filesystem failure to one durable outcome", async (t) => {
  await t.test("pre-publication rejection is durably absent", () => {
    const parent = temporaryParent(t);
    const descriptorPaths = new Map();
    const nativeClose = fsModule.closeSync;
    const nativeFsync = fsModule.fsyncSync;
    const nativeLink = fsModule.linkSync;
    const nativeOpen = fsModule.openSync;
    let failureArmed = false;
    let linkFailed = false;
    let rollbackSynced = false;
    const persistentQueue = loadPersistentQueueWith({
      filesystem: {
        closeSync(descriptor) {
          try {
            return nativeClose(descriptor);
          } finally {
            descriptorPaths.delete(descriptor);
          }
        },
        fsyncSync(descriptor) {
          if (linkFailed && descriptorPaths.get(descriptor) === queueDirectory(parent)) {
            rollbackSynced = true;
          }
          return nativeFsync(descriptor);
        },
        linkSync(temporaryPath, finalPath) {
          if (failureArmed) {
            linkFailed = true;
            throw injectedIoError();
          }
          return nativeLink(temporaryPath, finalPath);
        },
        openSync(path, ...args) {
          const descriptor = nativeOpen(path, ...args);
          descriptorPaths.set(descriptor, path);
          return descriptor;
        }
      }
    });
    const queue = persistentQueue.createPersistentEventQueue(queueConfig(parent));

    failureArmed = true;
    assertFixedStorageError(
      captureThrown(() => queue.append(queueRecord("durably-rejected"))),
      "persistent_queue_unavailable"
    );
    assert.equal(rollbackSynced, true);
    assert.deepEqual(
      readdirSync(queueDirectory(parent)).filter((name) => name.includes("event-")),
      []
    );
    queue.close();
  });

  await t.test("failed rejection proof permanently fails closed", () => {
    const parent = temporaryParent(t);
    const nativeLink = fsModule.linkSync;
    const nativeUnlink = fsModule.unlinkSync;
    let failureArmed = false;
    let linkFailed = false;
    const persistentQueue = loadPersistentQueueWith({
      filesystem: {
        linkSync(temporaryPath, finalPath) {
          if (failureArmed) {
            linkFailed = true;
            throw injectedIoError();
          }
          return nativeLink(temporaryPath, finalPath);
        },
        unlinkSync(path) {
          if (linkFailed && path.endsWith(".tmp")) {
            throw injectedIoError();
          }
          return nativeUnlink(path);
        }
      }
    });
    const queue = persistentQueue.createPersistentEventQueue(queueConfig(parent));

    failureArmed = true;
    const rejection = captureThrown(() => queue.append(queueRecord("unknown-rejection")));
    assertFixedStorageError(rejection, "persistent_queue_unavailable");
    assert.equal(rejection.message, "persistent queue admission rollback failed");
    assertFixedStorageError(captureThrown(() => queue.length()), "persistent_queue_unavailable");
  });

  await t.test("an unrecognized second link still fails closed", () => {
    const parent = temporaryParent(t);
    const persistentQueue = loadPersistentQueueWith({});
    const queue = persistentQueue.createPersistentEventQueue(queueConfig(parent));
    queue.append(queueRecord("linked-outside-queue"));
    fsModule.linkSync(
      join(queueDirectory(parent), eventFiles(parent)[0]),
      join(parent, "unrecognized-record-link")
    );

    assertFixedStorageError(
      captureThrown(() => queue.acknowledge(1)),
      "persistent_queue_unavailable"
    );
    queue.close();
  });

  const durablePublicationFailures = [
    {
      name: "temporary unlink",
      overrides(state) {
        const nativeUnlink = fsModule.unlinkSync;
        return {
          unlinkSync(path) {
            if (state.armed && state.injected === 0 && path.endsWith(".tmp")) {
              state.injected += 1;
              throw injectedIoError();
            }
            return nativeUnlink(path);
          }
        };
      }
    },
    {
      name: "temporary-link metadata flush",
      overrides(state) {
        const nativeFsync = fsModule.fsyncSync;
        return {
          fsyncSync(descriptor) {
            if (state.armed) {
              state.appendFsyncs += 1;
              if (state.appendFsyncs === 3) {
                state.injected += 1;
                throw injectedIoError();
              }
            }
            return nativeFsync(descriptor);
          }
        };
      }
    },
    {
      name: "post-publication final stat",
      overrides(state) {
        const nativeFsync = fsModule.fsyncSync;
        const nativeLstat = fsModule.lstatSync;
        return {
          fsyncSync(descriptor) {
            if (state.armed) {
              state.appendFsyncs += 1;
            }
            return nativeFsync(descriptor);
          },
          lstatSync(path) {
            if (
              state.armed
              && state.appendFsyncs >= 3
              && state.injected === 0
              && /\/event-[0-9]{16}\.json$/.test(path)
            ) {
              state.injected += 1;
              throw injectedIoError();
            }
            return nativeLstat(path);
          }
        };
      }
    }
  ];

  for (const scenario of durablePublicationFailures) {
    await t.test(scenario.name, () => {
      const parent = temporaryParent(t);
      const state = { appendFsyncs: 0, armed: false, injected: 0 };
      const persistentQueue = loadPersistentQueueWith({
        filesystem: scenario.overrides(state)
      });
      const queue = persistentQueue.createPersistentEventQueue(queueConfig(parent));

      state.armed = true;
      queue.append(queueRecord(`retained-after-${scenario.name.replaceAll(" ", "-")}`));
      assert.equal(queue.length(), 1);
      assert.equal(eventFiles(parent).length, 1);
      queue.close();

      const recoveredModule = require(persistentQueueModulePath);
      const recovered = recoveredModule.createPersistentEventQueue(queueConfig(parent));
      assert.equal(recovered.length(), 1);
      assert.match(recovered.events()[0].id, /^retained-after-/);
      recovered.acknowledge(1);
      recovered.close();
      delete require.cache[persistentQueueModulePath];
    });
  }
});

test("a concurrent owner fails closed and clean shutdown releases ownership", async (t) => {
  const parent = temporaryParent(t);
  const owner = createClient(parent);
  const error = captureThrown(() => createClient(parent));
  assertFixedStorageError(error, "persistent_queue_in_use");
  const childSource = `
    import { createLogBrewNodeClient } from ${JSON.stringify(SOURCE_MODULE_URL)};
    try {
      createLogBrewNodeClient({ apiKey: "SECOND_OWNER_KEY", persistentQueuePath: process.argv[1] });
      process.exit(1);
    } catch (error) {
      process.exit(error?.code === "persistent_queue_in_use" ? 23 : 2);
    }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", childSource, parent], {
    encoding: "utf8",
    timeout: 10_000
  });
  assert.equal(child.status, 23);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
  assertFixedStorageError(
    captureThrown(() => purgeLogBrewNodePersistentQueue({ persistentQueuePath: parent })),
    "persistent_queue_in_use"
  );

  await owner.shutdown(RecordingTransport.alwaysAccept());
  const nextOwner = createClient(parent);
  await nextOwner.shutdown(RecordingTransport.alwaysAccept());
});

test("hard exit replays retained events oldest first in the next process", async (t) => {
  const parent = temporaryParent(t);
  const childSource = `
    import { createLogBrewNodeClient } from ${JSON.stringify(SOURCE_MODULE_URL)};
    const client = createLogBrewNodeClient({ apiKey: "CHILD_KEY", persistentQueuePath: process.argv[1] });
    for (const id of ["restart-0", "restart-1", "restart-2"]) {
      client.log(id, ${JSON.stringify(FIXED_TIMESTAMP)}, { level: "info", message: "restart" });
    }
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", childSource, parent], {
    encoding: "utf8",
    timeout: 10_000
  });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");

  const ownerDirectory = join(queueDirectory(parent), ".owner");
  const leaseName = readdirSync(ownerDirectory)[0];
  const expired = new Date(0);
  utimesSync(join(ownerDirectory, leaseName), expired, expired);
  const recovered = createClient(parent);
  assert.equal(recovered.deliveryHealth().storage, "persistent");
  assert.equal(recovered.deliveryHealth().hydratedEvents, 3);
  assert.equal(recovered.deliveryHealth().hydratedBytes > 0, true);
  const transport = RecordingTransport.alwaysAccept();
  await recovered.shutdown(transport);
  assert.deepEqual(payloadEventIds(transport.sentBodies), ["restart-0", "restart-1", "restart-2"]);
});

test("malformed, oversized, unknown, weak, and linked storage fail closed", async (t) => {
  const cases = [
    {
      name: "malformed",
      prepare(child) {
        writeFileSync(join(child, "event-0000000000000001.json"), "{", { mode: 0o600 });
      }
    },
    {
      name: "oversized",
      prepare(child) {
        writeFileSync(join(child, "event-0000000000000001.json"), "x".repeat(513), { mode: 0o600 });
      },
      options: { maxQueueBytes: 512 }
    },
    {
      name: "unknown",
      prepare(child) {
        writeFileSync(join(child, "unexpected.bin"), "x", { mode: 0o600 });
      }
    },
    {
      name: "sequence-gap",
      prepare(child) {
        writeFileSync(join(child, "event-0000000000000001.json"), storedEvent("gap-first"), { mode: 0o600 });
        writeFileSync(join(child, "event-0000000000000003.json"), storedEvent("gap-third"), { mode: 0o600 });
      }
    },
    {
      name: "weak-mode",
      prepare(child) {
        writeFileSync(join(child, "event-0000000000000001.json"), "{}", { mode: 0o644 });
      }
    },
    {
      name: "linked-record",
      prepare(child) {
        const target = join(dirname(child), "outside-record");
        writeFileSync(target, "{}", { mode: 0o600 });
        symlinkSync(target, join(child, "event-0000000000000001.json"));
      }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const parent = temporaryParent(t);
      const child = queueDirectory(parent);
      mkdirSync(child, { mode: 0o700 });
      scenario.prepare(child);
      const error = captureThrown(() => createClient(parent, scenario.options));
      assertFixedStorageError(error, "persistent_queue_invalid");
    });
  }
});

test("a linked queue directory is rejected without falling back to memory", (t) => {
  const parent = temporaryParent(t);
  const target = temporaryParent(t);
  symlinkSync(target, queueDirectory(parent));

  const error = captureThrown(() => createClient(parent));
  assertFixedStorageError(error, "persistent_queue_invalid");
});

test("weak parent and queue directory modes are rejected", async (t) => {
  await t.test("parent", () => {
    const parent = temporaryParent(t);
    chmodSync(parent, 0o755);
    assertFixedStorageError(captureThrown(() => createClient(parent)), "persistent_queue_invalid");
  });
  await t.test("queue", () => {
    const parent = temporaryParent(t);
    mkdirSync(queueDirectory(parent), { mode: 0o755 });
    assertFixedStorageError(captureThrown(() => createClient(parent)), "persistent_queue_invalid");
  });
});

test("explicit purge removes only recognized SDK storage and rejects unknown entries", async (t) => {
  const parent = temporaryParent(t);
  const child = queueDirectory(parent);
  mkdirSync(child, { mode: 0o700 });
  writeFileSync(join(child, "event-0000000000000001.json"), "corrupt", { mode: 0o600 });

  assert.equal(purgeLogBrewNodePersistentQueue({ persistentQueuePath: parent }), true);
  assert.equal(readdirSync(parent).length, 0);

  mkdirSync(child, { mode: 0o700 });
  writeFileSync(join(child, "keep.txt"), "keep", { mode: 0o600 });
  const error = captureThrown(() => purgeLogBrewNodePersistentQueue({ persistentQueuePath: parent }));
  assertFixedStorageError(error, "persistent_queue_invalid");
  assert.equal(readFileSync(join(child, "keep.txt"), "utf8"), "keep");
});
