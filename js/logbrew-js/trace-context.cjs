const MAX_TRACESTATE_ENTRIES = 32;
const MAX_TRACESTATE_LENGTH = 512;
const MAX_BAGGAGE_ENTRIES = 64;
const MAX_BAGGAGE_LENGTH = 8192;
const TRACESTATE_SIMPLE_KEY_PATTERN = /^[a-z0-9][a-z0-9_\-*/]{0,255}$/u;
const TRACESTATE_TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9_\-*/]{0,240}@[a-z][a-z0-9_\-*/]{0,13}$/u;
const TRACESTATE_VALUE_PATTERN = /^[\x20-\x2B\x2D-\x3C\x3E-\x7E]*[\x21-\x2B\x2D-\x3C\x3E-\x7E]$/u;
const BAGGAGE_KEY_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const BAGGAGE_PROPERTY_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:=[!#$%&'*+\-.^_`|~0-9A-Za-z]*)?$/u;

function buildTraceContextHelpers({ SdkError, createTraceparent }) {
  function parseTracestate(tracestate) {
    if (typeof tracestate !== "string" || tracestate.trim() === "") {
      throw new SdkError("validation_error", "tracestate must be non-empty");
    }
    return normalizeTracestateEntries(
      tracestate.split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
        .map((entry) => {
          const separator = entry.indexOf("=");
          if (separator <= 0) {
            throw new SdkError("validation_error", "tracestate entries must use key=value");
          }
          return {
            key: entry.slice(0, separator).trim(),
            value: entry.slice(separator + 1).trim()
          };
        })
    );
  }

  function createTracestate(entries) {
    return serializeTracestate(normalizeTracestateEntries(entries));
  }

  function parseBaggage(baggage) {
    if (typeof baggage !== "string" || baggage.trim() === "") {
      throw new SdkError("validation_error", "baggage must be non-empty");
    }
    return normalizeBaggageEntries(
      baggage.split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
        .map((entry) => {
          const [pair, ...rawProperties] = entry.split(";");
          const separator = pair.indexOf("=");
          if (separator <= 0) {
            throw new SdkError("validation_error", "baggage entries must use key=value");
          }
          return {
            key: pair.slice(0, separator).trim(),
            value: decodeBaggageValue(pair.slice(separator + 1).trim()),
            properties: rawProperties.map((property) => property.trim()).filter((property) => property !== "")
          };
        })
    );
  }

  function createBaggage(entries) {
    return serializeBaggage(normalizeBaggageEntries(entries));
  }

  function createTraceContextHeaders(input) {
    if (!input || Array.isArray(input) || typeof input !== "object") {
      throw new SdkError("validation_error", "trace context input must be an object");
    }
    const headers = { traceparent: createTraceparent(input) };
    if (input.tracestate !== undefined) {
      const tracestate = typeof input.tracestate === "string"
        ? createTracestate(parseTracestate(input.tracestate))
        : createTracestate(input.tracestate);
      if (tracestate !== "") {
        headers.tracestate = tracestate;
      }
    }
    if (input.baggage !== undefined) {
      const baggage = typeof input.baggage === "string"
        ? createBaggage(parseBaggage(input.baggage))
        : createBaggage(input.baggage);
      if (baggage !== "") {
        headers.baggage = baggage;
      }
    }
    return headers;
  }

  function normalizeTracestateEntries(entries) {
    if (!Array.isArray(entries)) {
      throw new SdkError("validation_error", "tracestate entries must be an array");
    }
    if (entries.length > MAX_TRACESTATE_ENTRIES) {
      throw new SdkError("validation_error", `tracestate must contain at most ${MAX_TRACESTATE_ENTRIES} entries`);
    }
    const seenKeys = new Set();
    const normalized = entries.map((entry) => {
      if (!entry || Array.isArray(entry) || typeof entry !== "object") {
        throw new SdkError("validation_error", "tracestate entry must be an object");
      }
      const key = validateTracestateKey(entry.key);
      if (seenKeys.has(key)) {
        throw new SdkError("validation_error", "tracestate keys must be unique");
      }
      seenKeys.add(key);
      return {
        key,
        value: validateTracestateValue(entry.value)
      };
    });
    const serialized = serializeTracestate(normalized);
    if (serialized.length > MAX_TRACESTATE_LENGTH) {
      throw new SdkError("validation_error", `tracestate must be at most ${MAX_TRACESTATE_LENGTH} characters`);
    }
    return normalized;
  }

  function normalizeBaggageEntries(entries) {
    if (!Array.isArray(entries)) {
      throw new SdkError("validation_error", "baggage entries must be an array");
    }
    if (entries.length > MAX_BAGGAGE_ENTRIES) {
      throw new SdkError("validation_error", `baggage must contain at most ${MAX_BAGGAGE_ENTRIES} entries`);
    }
    const normalized = entries.map((entry) => {
      if (!entry || Array.isArray(entry) || typeof entry !== "object") {
        throw new SdkError("validation_error", "baggage entry must be an object");
      }
      return {
        key: validateBaggageKey(entry.key),
        value: validateBaggageValue(entry.value),
        ...normalizeBaggageProperties(entry.properties)
      };
    });
    const serialized = serializeBaggage(normalized);
    if (serialized.length > MAX_BAGGAGE_LENGTH) {
      throw new SdkError("validation_error", `baggage must be at most ${MAX_BAGGAGE_LENGTH} characters`);
    }
    return normalized;
  }

  function validateTracestateKey(key) {
    if (typeof key !== "string" || key.trim() === "") {
      throw new SdkError("validation_error", "tracestate key must be non-empty");
    }
    const normalized = key.trim();
    if (!TRACESTATE_SIMPLE_KEY_PATTERN.test(normalized) && !TRACESTATE_TENANT_KEY_PATTERN.test(normalized)) {
      throw new SdkError("validation_error", "tracestate key must be lowercase W3C tracestate key");
    }
    return normalized;
  }

  function validateTracestateValue(value) {
    if (typeof value !== "string" || value === "" || value.length > 256 || !TRACESTATE_VALUE_PATTERN.test(value)) {
      throw new SdkError("validation_error", "tracestate value must be printable ASCII without comma or equals");
    }
    return value;
  }

  function validateBaggageKey(key) {
    if (typeof key !== "string" || !BAGGAGE_KEY_PATTERN.test(key)) {
      throw new SdkError("validation_error", "baggage key must use RFC header-name characters");
    }
    return key;
  }

  function validateBaggageValue(value) {
    if (typeof value !== "string") {
      throw new SdkError("validation_error", "baggage value must be a string");
    }
    return value;
  }

  function normalizeBaggageProperties(properties) {
    if (properties === undefined) {
      return {};
    }
    if (!Array.isArray(properties)) {
      throw new SdkError("validation_error", "baggage properties must be an array");
    }
    const safeProperties = properties.map((property) => {
      if (typeof property !== "string" || !BAGGAGE_PROPERTY_PATTERN.test(property)) {
        throw new SdkError("validation_error", "baggage property must use RFC header-name characters");
      }
      return property;
    });
    return safeProperties.length > 0 ? { properties: safeProperties } : {};
  }

  function decodeBaggageValue(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      throw new SdkError("validation_error", "baggage value must use valid percent encoding");
    }
  }

  return {
    createBaggage,
    createTraceContextHeaders,
    createTracestate,
    parseBaggage,
    parseTracestate
  };
}

function serializeTracestate(entries) {
  return entries.map((entry) => `${entry.key}=${entry.value}`).join(",");
}

function serializeBaggage(entries) {
  return entries.map((entry) => {
    const properties = entry.properties ? `;${entry.properties.join(";")}` : "";
    return `${entry.key}=${encodeURIComponent(entry.value)}${properties}`;
  }).join(",");
}

module.exports = { buildTraceContextHelpers };
