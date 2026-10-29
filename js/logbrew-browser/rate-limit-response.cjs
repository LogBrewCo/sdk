"use strict";

const RATE_LIMIT_BODY_LIMIT_BYTES = 4096;
const HTTP_DATE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/u;

// Returns the status plus the Retry-After delay and, for a 429, a known body `code`.
async function transportResponse(response) {
  const retryAfterMs = retryAfterMsFromHeader(response.headers?.get?.("retry-after"));
  const errorCode = response.status === 429 ? await rateLimitCode(response) : undefined;
  return {
    statusCode: response.status,
    attempts: 1,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(errorCode === undefined ? {} : { errorCode })
  };
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
  // Only an HTTP date counts; a repeated header arrives comma-joined and is ignored.
  const timestamp = HTTP_DATE.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

// Reads a 429 body only when it declares at most 4 KiB, and only to find a known `code`.
async function rateLimitCode(response) {
  try {
    const length = Number(response.headers?.get?.("content-length"));
    if (!Number.isSafeInteger(length) || length > RATE_LIMIT_BODY_LIMIT_BYTES || typeof response.text !== "function") {
      return undefined;
    }
    const text = await response.text();
    const code = text.length <= RATE_LIMIT_BODY_LIMIT_BYTES ? JSON.parse(text)?.code : undefined;
    return code === "rate_limited" || code === "usage_limit_exceeded" ? code : undefined;
  } catch {
    return undefined;
  }
}

module.exports = { retryAfterMsFromHeader, transportResponse };
