import { SdkError, TransportError } from "@logbrew/sdk";

const DEFAULT_MAX_BEACON_BODY_BYTES = 60 * 1024;

export function createBeaconTransport({
  endpoint,
  fetchImpl = defaultFetch(),
  maxBeaconBodyBytes = DEFAULT_MAX_BEACON_BODY_BYTES,
  sendBeacon = defaultSendBeacon()
} = {}) {
  validateEndpoint(endpoint);
  validateBeaconBodyLimit(maxBeaconBodyBytes);
  if (sendBeacon !== undefined && typeof sendBeacon !== "function") {
    throw new SdkError("configuration_error", "createBeaconTransport sendBeacon must be a function");
  }
  if (fetchImpl !== undefined && typeof fetchImpl !== "function") {
    throw new SdkError("configuration_error", "createBeaconTransport fetchImpl must be a function");
  }
  if (sendBeacon === undefined && fetchImpl === undefined) {
    throw new SdkError("configuration_error", "createBeaconTransport requires sendBeacon or fetch");
  }

  return {
    async send(apiKey, body) {
      const beaconBody = createBeaconRequestBody(apiKey, body);
      if (sendBeacon && utf8ByteLength(beaconBody) <= maxBeaconBodyBytes) {
        try {
          if (sendBeacon(endpoint, createBeaconPayload(beaconBody))) {
            return { statusCode: 202, attempts: 1, queued: true };
          }
        } catch {
          // Browser beacon is best-effort; fall through to fetch so callers can retry on status.
        }
      }
      return sendWithFetch(fetchImpl, endpoint, beaconBody, utf8ByteLength(beaconBody) <= maxBeaconBodyBytes);
    }
  };
}

function createBeaconRequestBody(apiKey, body) {
  return JSON.stringify({
    envelope: parseEnvelope(body),
    ingest_key: apiKey
  });
}

function parseEnvelope(body) {
  try {
    return JSON.parse(typeof body === "string" ? body : String(body));
  } catch {
    throw new TransportError("beacon_envelope_invalid", "browser beacon transport requires a JSON telemetry envelope", false);
  }
}

function createBeaconPayload(body) {
  const BlobConstructor = globalThis.Blob;
  if (typeof BlobConstructor === "function") {
    return new BlobConstructor([body], { type: "application/json" });
  }
  return body;
}

async function sendWithFetch(fetchImpl, endpoint, body, keepalive) {
  if (typeof fetchImpl !== "function") {
    throw TransportError.network("browser beacon fallback fetch is unavailable");
  }
  try {
    const response = await fetchImpl(endpoint, {
      body,
      headers: {
        "content-type": "application/json"
      },
      keepalive,
      method: "POST"
    });
    const retryAfterMs = retryAfterMsFromHeaders(response.headers);
    return retryAfterMs === undefined
      ? { statusCode: response.status, attempts: 1, queued: false }
      : { statusCode: response.status, attempts: 1, queued: false, retryAfterMs };
  } catch (error) {
    throw TransportError.network(`browser beacon fallback fetch failed: ${errorMessage(error)}`);
  }
}

function validateEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new SdkError("configuration_error", "createBeaconTransport requires a non-empty endpoint");
  }
}

function validateBeaconBodyLimit(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SdkError("configuration_error", "maxBeaconBodyBytes must be a positive integer");
  }
}

function defaultFetch() {
  return typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
}

function defaultSendBeacon() {
  const navigatorObject = globalThis.navigator;
  return typeof navigatorObject?.sendBeacon === "function"
    ? navigatorObject.sendBeacon.bind(navigatorObject)
    : undefined;
}

function retryAfterMsFromHeaders(headers) {
  if (!headers || typeof headers.get !== "function") {
    return undefined;
  }
  return retryAfterMsFromHeader(headers.get("retry-after"));
}

function retryAfterMsFromHeader(value, now = Date.now()) {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
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
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
