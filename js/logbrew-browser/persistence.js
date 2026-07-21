import { SdkError } from "@logbrew/sdk";
import { lifecycleTransportFor, markLifecycleTransport } from "./lifecycle-transport.js";

const DEFAULT_PERSISTENCE_STORAGE_KEY = "logbrew:browser:persisted-batches";
const DEFAULT_PERSISTENCE_LOCK_NAME = "logbrew:browser:persistence";
const DEFAULT_MAX_STORED_BATCHES = 10;
const DEFAULT_MAX_STORED_BYTES = 256 * 1024;

let persistentTransportInstance = 0;

export function createPersistentBrowserTransport({
  lockManager = defaultPersistenceLockManager(),
  maxStoredBatches = DEFAULT_MAX_STORED_BATCHES,
  maxStoredBytes = DEFAULT_MAX_STORED_BYTES,
  onPersistError,
  storage = defaultPersistentStorage(),
  storageKey = DEFAULT_PERSISTENCE_STORAGE_KEY,
  transport
} = {}) {
  validateTransport(transport, "createPersistentBrowserTransport requires transport");
  validateLockManager(lockManager);
  validateStorage(storage);
  validateStorageKey(storageKey);
  validatePersistenceLimit("maxStoredBatches", maxStoredBatches);
  validatePersistenceLimit("maxStoredBytes", maxStoredBytes);
  const lockName = persistenceLockName(storageKey);
  const ownerId = nextPersistentTransportOwnerId();

  const persistentTransport = {
    async send(apiKey, body) {
      return sendPersistentBatch({
        apiKey,
        body,
        lockManager,
        lockName,
        maxStoredBatches,
        maxStoredBytes,
        onPersistError,
        ownerId,
        send: transport.send.bind(transport),
        storage,
        storageKey
      });
    },
    async replayStoredBatches(apiKey, { skipOwnBatches = false } = {}) {
      return withPersistenceLock(lockManager, lockName, () => (
        replayPersistentBatches({
          apiKey,
          onPersistError,
          ownerId: skipOwnBatches ? ownerId : undefined,
          storage,
          storageKey,
          transport
        })
      ));
    },
    clearStoredBatches() {
      clearPersistentBatches({ onPersistError, storage, storageKey });
    },
    pendingStoredBatches() {
      return readPersistentBatches({ onPersistError, storage, storageKey }).length;
    }
  };
  const lifecycleTransport = lifecycleTransportFor(transport);
  if (lifecycleTransport) {
    markLifecycleTransport(persistentTransport, (apiKey, body) => sendPersistentBatch({
      apiKey,
      body,
      lockManager,
      lockName,
      maxStoredBatches,
      maxStoredBytes,
      onPersistError,
      ownerId,
      send: lifecycleTransport.send.bind(lifecycleTransport),
      storage,
      storageKey
    }));
  }
  return persistentTransport;
}

async function sendPersistentBatch({
  apiKey,
  body,
  lockManager,
  lockName,
  maxStoredBatches,
  maxStoredBytes,
  onPersistError,
  ownerId,
  send,
  storage,
  storageKey
}) {
  return withPersistenceLock(lockManager, lockName, async () => {
    storePersistentBatch({
      body,
      maxStoredBatches,
      maxStoredBytes,
      onPersistError,
      ownerId,
      storage,
      storageKey
    });
    const response = await send(apiKey, body);
    if (response?.statusCode >= 200 && response.statusCode < 300) {
      removePersistentBatchesForOwner({ onPersistError, ownerId, storage, storageKey });
    } else if (shouldClearPersistedBatch(response?.statusCode)) {
      removePersistentBatch({ body, onPersistError, storage, storageKey });
    }
    return response;
  });
}

function storePersistentBatch({
  body,
  maxStoredBatches,
  maxStoredBytes,
  onPersistError,
  ownerId,
  storage,
  storageKey
}) {
  const text = typeof body === "string" ? body : String(body);
  if (utf8ByteLength(text) > maxStoredBytes) {
    recordPersistError(onPersistError, "persisted_batch_too_large", "browser batch exceeds maxStoredBytes");
    return;
  }

  const existing = readPersistentBatches({ onPersistError, storage, storageKey })
    .filter((batch) => batch.body !== text);
  existing.push({ body: text, ownerId, storedAt: new Date().toISOString() });
  const trimmed = trimPersistentBatches(existing, maxStoredBatches, maxStoredBytes);
  if (!trimmed.some((batch) => batch.body === text)) {
    recordPersistError(onPersistError, "persisted_queue_full", "browser batch could not fit in persistent queue");
    return;
  }
  writePersistentBatches({ batches: trimmed, onPersistError, storage, storageKey });
}

async function replayPersistentBatches({
  apiKey,
  onPersistError,
  ownerId,
  storage,
  storageKey,
  transport
}) {
  const batches = readPersistentBatches({ onPersistError, storage, storageKey })
    .filter((batch) => batch.ownerId !== ownerId);
  let attempted = 0;
  let delivered = 0;
  for (const batch of batches) {
    attempted += 1;
    try {
      const response = await transport.send(apiKey, batch.body);
      if (response?.statusCode >= 200 && response.statusCode < 300) {
        delivered += 1;
        removePersistentBatch({ body: batch.body, onPersistError, storage, storageKey });
        continue;
      }
      if (shouldClearPersistedBatch(response?.statusCode)) {
        removePersistentBatch({ body: batch.body, onPersistError, storage, storageKey });
        continue;
      }
      break;
    } catch {
      break;
    }
  }
  return {
    attempted,
    delivered,
    retained: readPersistentBatches({ onPersistError, storage, storageKey }).length
  };
}

function trimPersistentBatches(batches, maxStoredBatches, maxStoredBytes) {
  const trimmed = batches.slice(-maxStoredBatches);
  while (trimmed.length > 0 && utf8ByteLength(persistentPayloadJson(trimmed)) > maxStoredBytes) {
    trimmed.shift();
  }
  return trimmed;
}

function readPersistentBatches({ onPersistError, storage, storageKey }) {
  try {
    const raw = storage.getItem(storageKey);
    if (raw === null || raw === undefined || raw === "") {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.batches)) {
      throw new Error("invalid persistent batch payload");
    }
    return parsed.batches
      .filter((batch) => typeof batch?.body === "string" && typeof batch?.storedAt === "string")
      .map((batch) => ({
        body: batch.body,
        ownerId: typeof batch.ownerId === "string" ? batch.ownerId : undefined,
        storedAt: batch.storedAt
      }));
  } catch {
    clearPersistentBatches({ onPersistError, storage, storageKey });
    recordPersistError(onPersistError, "persisted_storage_corrupt", "browser persistent queue was reset");
    return [];
  }
}

function writePersistentBatches({ batches, onPersistError, storage, storageKey }) {
  try {
    if (batches.length === 0) {
      storage.removeItem(storageKey);
      return;
    }
    storage.setItem(storageKey, persistentPayloadJson(batches));
  } catch {
    recordPersistError(onPersistError, "persisted_storage_unavailable", "browser persistent queue could not be written");
  }
}

function removePersistentBatch({ body, onPersistError, storage, storageKey }) {
  const batches = readPersistentBatches({ onPersistError, storage, storageKey })
    .filter((batch) => batch.body !== body);
  writePersistentBatches({ batches, onPersistError, storage, storageKey });
}

function removePersistentBatchesForOwner({ onPersistError, ownerId, storage, storageKey }) {
  const batches = readPersistentBatches({ onPersistError, storage, storageKey })
    .filter((batch) => batch.ownerId !== ownerId);
  writePersistentBatches({ batches, onPersistError, storage, storageKey });
}

function clearPersistentBatches({ onPersistError, storage, storageKey }) {
  try {
    storage.removeItem(storageKey);
  } catch {
    recordPersistError(onPersistError, "persisted_storage_unavailable", "browser persistent queue could not be cleared");
  }
}

function persistentPayloadJson(batches) {
  return JSON.stringify({ version: 1, batches });
}

function shouldClearPersistedBatch(statusCode) {
  return typeof statusCode === "number" && (
    (statusCode >= 200 && statusCode < 300) ||
    (statusCode >= 400 && statusCode < 500 && statusCode !== 429)
  );
}

function validateTransport(transport, message) {
  if (!transport || typeof transport.send !== "function") {
    throw new SdkError("configuration_error", message);
  }
}

function validateLockManager(lockManager) {
  if (lockManager !== undefined && (!lockManager || typeof lockManager.request !== "function")) {
    throw new SdkError("configuration_error", "persistent browser delivery requires lockManager.request when configured");
  }
}

function validateStorage(storage) {
  if (
    !storage ||
    typeof storage.getItem !== "function" ||
    typeof storage.setItem !== "function" ||
    typeof storage.removeItem !== "function"
  ) {
    throw new SdkError("configuration_error", "persistent browser delivery requires storage with getItem, setItem, and removeItem");
  }
}

function validateStorageKey(storageKey) {
  if (typeof storageKey !== "string" || storageKey.trim() === "") {
    throw new SdkError("configuration_error", "persistent browser delivery requires a non-empty storageKey");
  }
}

function validatePersistenceLimit(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SdkError("configuration_error", `${name} must be a positive integer`);
  }
}

function recordPersistError(onPersistError, code, message) {
  if (typeof onPersistError !== "function") {
    return;
  }
  try {
    onPersistError({ code, message });
  } catch {
    // Persistence callbacks are advisory and must not interrupt application telemetry.
  }
}

function nextPersistentTransportOwnerId() {
  persistentTransportInstance += 1;
  return `browser:${Date.now()}:${persistentTransportInstance}`;
}

function defaultPersistentStorage() {
  return globalThis.localStorage;
}

function defaultPersistenceLockManager() {
  return globalThis.navigator?.locks;
}

function persistenceLockName(storageKey) {
  if (storageKey === DEFAULT_PERSISTENCE_STORAGE_KEY) {
    return DEFAULT_PERSISTENCE_LOCK_NAME;
  }
  return `${DEFAULT_PERSISTENCE_LOCK_NAME}:${stableStorageKeyHash(storageKey)}`;
}

function stableStorageKeyHash(storageKey) {
  let hash = 2166136261;
  for (let index = 0; index < storageKey.length; index += 1) {
    hash ^= storageKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function withPersistenceLock(lockManager, lockName, callback) {
  if (!lockManager) {
    return callback();
  }
  let callbackStarted = false;
  try {
    return await lockManager.request(lockName, { mode: "exclusive" }, () => {
      callbackStarted = true;
      return callback();
    });
  } catch (error) {
    if (callbackStarted) {
      throw error;
    }
    return callback();
  }
}

function utf8ByteLength(value) {
  const text = typeof value === "string" ? value : String(value);
  const TextEncoderConstructor = globalThis.TextEncoder;
  if (typeof TextEncoderConstructor === "function") {
    return new TextEncoderConstructor().encode(text).byteLength;
  }
  return fallbackUtf8ByteLength(text);
}

function fallbackUtf8ByteLength(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint > 0xffff) {
      index += 1;
    }
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}
