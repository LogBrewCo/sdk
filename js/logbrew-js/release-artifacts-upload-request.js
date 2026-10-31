import { errorMessage, mapInOrder, stableJson } from "./release-artifacts-common.js";
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * @import { JsonObject } from "./release-artifacts-common.js"
 * @typedef {"auth_failed" | "retryable_error" | "upload_failed" | "uploaded" | "validation_failed"} UploadResult
 * @typedef {{ readonly attempt: number, readonly httpStatus?: number, readonly result: UploadResult }} UploadAttempt
 * @typedef {readonly [name: string, filePath: string]} UploadFile
 * @typedef {{
 *   readonly body: Buffer,
 *   readonly boundary: string,
 *   readonly endpoint: string,
 *   readonly maxRetries: number,
 *   readonly retryDelaySeconds: number,
 *   readonly timeoutSeconds: number,
 *   readonly token: string
 * }} UploadRequest
 */

const HOSTED_UPLOAD_ENDPOINT = "https://api.logbrew.co/api/release-artifacts";
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_TOO_MANY_REQUESTS = 429;
const AUTH_FAILED_STATUSES = new Set([HTTP_UNAUTHORIZED, HTTP_FORBIDDEN]);
const NON_RETRYABLE_UPLOAD_STATUSES = new Set([HTTP_BAD_REQUEST, HTTP_UNAUTHORIZED, HTTP_FORBIDDEN, HTTP_PAYLOAD_TOO_LARGE]);
const RETRYABLE_UPLOAD_STATUSES = new Set([HTTP_REQUEST_TIMEOUT, HTTP_TOO_MANY_REQUESTS]);
const SUCCESS_STATUS_MIN = 200;
const SUCCESS_STATUS_LIMIT = 300;
const SERVER_ERROR_STATUS_MIN = 500;
const MILLISECONDS_PER_SECOND = 1000;
const FIRST_ATTEMPT = 1;
const NO_RETRY_DELAY = 0;
const NOT_AN_IP = 0;
const SCRIPT_VERSION = "0.1.0";

/**
 * @param {string} endpoint
 * @returns {string}
 */
function endpointWithoutQuery(endpoint) {
  const { host, pathname, protocol } = new URL(endpoint);
  return `${protocol}//${host}${pathname === "" ? "/" : pathname}`;
}

/**
 * @param {string} endpoint
 * @returns {URL}
 */
function parseEndpoint(endpoint) {
  try {
    const parsed = new URL(endpoint);
    if (["http:", "https:"].includes(parsed.protocol)) {
      return parsed;
    }
  } catch (error) {
    throw new Error(`upload endpoint is not a valid URL: ${errorMessage(error)}`, { cause: error });
  }
  throw new Error("release artifact upload proof endpoint must use http or https");
}

/**
 * @param {string} endpointHostname
 * @returns {boolean}
 */
function isLoopbackEndpoint(endpointHostname) {
  const hostname = endpointHostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    (net.isIP(hostname) !== NOT_AN_IP && (hostname.startsWith("127.") || hostname === "::1"))
  );
}

/**
 * @param {string} endpoint
 * @returns {boolean}
 */
function isLoopbackUploadEndpoint(endpoint) {
  return isLoopbackEndpoint(parseEndpoint(endpoint).hostname);
}

/**
 * @param {string} endpoint
 * @param {boolean} allowHosted
 * @returns {boolean}
 */
function requireUploadEndpoint(endpoint, allowHosted) {
  if (isLoopbackUploadEndpoint(endpoint)) {
    return true;
  }
  if (!allowHosted) {
    throw new Error("release artifact hosted upload requires explicit --allow-hosted; use loopback endpoints for local proof");
  }
  if (endpoint !== HOSTED_UPLOAD_ENDPOINT) {
    throw new Error(`hosted release artifact uploads must use ${HOSTED_UPLOAD_ENDPOINT}`);
  }
  return false;
}

/**
 * @param {string} value
 * @returns {string}
 */
function quoteMultipartValue(value) {
  return value.replaceAll("\\", String.raw`\\`).replaceAll("\"", String.raw`\"`);
}

/**
 * @param {string} boundary
 * @param {{ readonly contentType: string, readonly filename: string, readonly name: string }} part
 * @param {Buffer} bytes
 * @returns {Buffer[]}
 */
function multipartPart(boundary, { contentType, filename, name }, bytes) {
  return [
    Buffer.from(`--${boundary}\r\n`, "ascii"),
    Buffer.from(
      `Content-Disposition: form-data; name="${quoteMultipartValue(name)}"; filename="${quoteMultipartValue(filename)}"\r\n`,
      "utf8"
    ),
    Buffer.from(`Content-Type: ${contentType}\r\n\r\n`, "ascii"),
    bytes,
    Buffer.from("\r\n", "ascii")
  ];
}

/**
 * @param {JsonObject} manifest
 * @param {readonly UploadFile[]} files
 * @returns {Promise<{ readonly body: Buffer, readonly boundary: string }>}
 */
async function encodeMultipart(manifest, files) {
  const boundary = `logbrew-${randomUUID().replaceAll("-", "")}`;
  const manifestPart = multipartPart(
    boundary,
    { contentType: "application/json", filename: "manifest.json", name: "manifest" },
    Buffer.from(stableJson(manifest), "utf8")
  );
  const fileParts = await mapInOrder(files, async ([name, filePath]) =>
    multipartPart(boundary, { contentType: "application/octet-stream", filename: path.basename(filePath), name }, await readFile(filePath)));
  return {
    body: Buffer.concat([...manifestPart, ...fileParts.flat(), Buffer.from(`--${boundary}--\r\n`, "ascii")]),
    boundary
  };
}

/**
 * @param {number} status
 * @returns {UploadResult}
 */
function classifyUploadStatus(status) {
  if (status >= SUCCESS_STATUS_MIN && status < SUCCESS_STATUS_LIMIT) {
    return "uploaded";
  }
  if (AUTH_FAILED_STATUSES.has(status)) {
    return "auth_failed";
  }
  if (NON_RETRYABLE_UPLOAD_STATUSES.has(status)) {
    return "validation_failed";
  }
  if (RETRYABLE_UPLOAD_STATUSES.has(status) || status >= SERVER_ERROR_STATUS_MIN) {
    return "retryable_error";
  }
  return "upload_failed";
}

/**
 * @param {UploadRequest} request
 * @returns {Promise<number>}
 */
async function postMultipart({ body, boundary, endpoint, timeoutSeconds, token }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutSeconds * MILLISECONDS_PER_SECOND);
  try {
    const response = await fetch(endpoint, {
      body,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "User-Agent": `logbrew-release-artifact-verifier/${SCRIPT_VERSION}`
      },
      method: "POST",
      signal: controller.signal
    });
    await response.arrayBuffer();
    return response.status;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @param {UploadRequest} request
 * @param {number} attempt
 * @returns {Promise<UploadAttempt>}
 */
async function attemptUpload(request, attempt) {
  try {
    const httpStatus = await postMultipart(request);
    return { attempt, httpStatus, result: classifyUploadStatus(httpStatus) };
  } catch {
    return { attempt, result: "retryable_error" };
  }
}

/**
 * @param {UploadRequest} request
 * @returns {Promise<{ readonly attempts: readonly UploadAttempt[], readonly retryCount: number, readonly status: UploadResult }>}
 */
async function uploadWithRetries(request) {
  /** @type {UploadAttempt[]} */
  const attempts = [];
  /**
   * @param {number} attempt
   * @returns {Promise<void>}
   */
  async function attemptFrom(attempt) {
    const outcome = await attemptUpload(request, attempt);
    attempts.push(outcome);
    if (outcome.result === "retryable_error" && attempt <= request.maxRetries) {
      if (request.retryDelaySeconds > NO_RETRY_DELAY) {
        await delay(request.retryDelaySeconds * MILLISECONDS_PER_SECOND);
      }
      await attemptFrom(attempt + FIRST_ATTEMPT);
    }
  }
  await attemptFrom(FIRST_ATTEMPT);
  return {
    attempts,
    retryCount: Math.max(NO_RETRY_DELAY, attempts.length - FIRST_ATTEMPT),
    status: attempts.at(-FIRST_ATTEMPT)?.result ?? "upload_failed"
  };
}

export { encodeMultipart, endpointWithoutQuery, isLoopbackUploadEndpoint, requireUploadEndpoint, uploadWithRetries };
