"use strict";

const { isCallable, readField, stringValue, toText, utf8ByteLength } = require("./instrumentation-values.cjs");

const MIN_BYTES = 0;
const DECIMAL = 10;

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isByteCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_BYTES;
}

/**
 * @param {unknown} target
 * @param {string} name
 * @returns {Promise<unknown>}
 */
async function callMethod(target, name) {
  const method = readField(target, name);
  return isCallable(method) ? Reflect.apply(method, target, []) : undefined;
}

/**
 * @param {unknown} response
 * @param {string} name
 * @returns {unknown}
 */
function responseHeader(response, name) {
  const headers = readField(response, "headers");
  const get = readField(headers, "get");
  if (!isCallable(get)) {
    return undefined;
  }
  try {
    return Reflect.apply(get, headers, [name]) ?? Reflect.apply(get, headers, [name.toLowerCase()]) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} response
 * @returns {number | undefined}
 */
function responseContentLengthBytes(response) {
  const header = responseHeader(response, "Content-Length");
  const value = Number.parseInt(toText(header ?? ""), DECIMAL);
  return Number.isFinite(value) && value >= MIN_BYTES ? value : undefined;
}

/**
 * @param {unknown} response
 * @returns {Promise<number | undefined>}
 */
async function responseArrayBufferSizeBytes(response) {
  if (!isCallable(readField(response, "arrayBuffer"))) {
    return undefined;
  }
  try {
    const byteLength = readField(await callMethod(response, "arrayBuffer"), "byteLength");
    return isByteCount(byteLength) ? byteLength : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} response
 * @returns {Promise<number | undefined>}
 */
async function responseBlobSizeBytes(response) {
  if (!isCallable(readField(response, "blob"))) {
    return undefined;
  }
  try {
    const size = readField(await callMethod(response, "blob"), "size");
    return isByteCount(size) ? size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} response
 * @returns {Promise<number | undefined>}
 */
async function responseTextSizeBytes(response) {
  if (!isCallable(readField(response, "text"))) {
    return undefined;
  }
  try {
    const text = stringValue(await callMethod(response, "text"));
    return text === undefined ? undefined : utf8ByteLength(text);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} response
 * @returns {Promise<number | undefined>}
 */
async function responseBodySizeBytes(response) {
  const arrayBufferSize = await responseArrayBufferSizeBytes(response);
  if (arrayBufferSize !== undefined) {
    return arrayBufferSize;
  }
  const blobSize = await responseBlobSizeBytes(response);
  if (blobSize !== undefined) {
    return blobSize;
  }
  return responseTextSizeBytes(response);
}

/**
 * @param {unknown} response
 * @param {(...args: readonly unknown[]) => unknown} clone
 * @returns {unknown}
 */
function cloneResponse(response, clone) {
  try {
    return Reflect.apply(clone, response, []);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} response
 * @returns {Promise<number | undefined>}
 */
async function clonedResponseBodySizeBytes(response) {
  if (!isCallable(readField(response, "clone"))) {
    return undefined;
  }
  const clone = readField(response, "clone");
  return isCallable(clone) ? responseBodySizeBytes(cloneResponse(response, clone)) : undefined;
}

/**
 * @param {unknown} response
 * @param {boolean} measureResponseBodySize
 * @returns {Promise<number | undefined>}
 */
async function responseSizeBytesFromResponse(response, measureResponseBodySize) {
  const contentLength = responseContentLengthBytes(response);
  if (contentLength !== undefined) {
    return contentLength;
  }
  return measureResponseBodySize ? clonedResponseBodySizeBytes(response) : undefined;
}

module.exports = { responseSizeBytesFromResponse };
