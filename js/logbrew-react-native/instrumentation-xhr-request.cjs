"use strict";

const {
  elapsedMs,
  errorName,
  indexRuntime,
  isCallable,
  isWritableRecord,
  metadataRuntime,
  readField,
  stringValue,
  toText,
  utf8ByteLength
} = require("./instrumentation-values.cjs");

/**
 * @import { LogBrewClient, Metadata, SpanAttributes } from "@logbrew/sdk"
 * @import { TracePropagationTarget } from "./index.cjs"
 * @import { AppStateInput, Callable, PlatformInput, TraceInput } from "./instrumentation-values.cjs"
 */

/**
 * @typedef {{
 *   readonly appState: AppStateInput | undefined,
 *   readonly client: LogBrewClient,
 *   readonly doneState: unknown,
 *   readonly headersReceivedState: unknown,
 *   readonly measureXhrResponseBodySize: boolean,
 *   readonly metadata: Readonly<Metadata>,
 *   readonly metadataFactory: unknown,
 *   readonly nowMs: () => number,
 *   readonly platform: PlatformInput | undefined,
 *   readonly routeTemplate: string | undefined,
 *   readonly routeTemplateFactory: (context: { readonly url: unknown }) => unknown,
 *   readonly screen: string | undefined,
 *   readonly sessionId: string | undefined,
 *   readonly status: SpanAttributes["status"] | undefined,
 *   readonly trace: TraceInput
 * }} XhrCaptureSettings
 * @typedef {{ readonly open: Callable, readonly send: Callable, readonly setRequestHeader: Callable }} XhrMethods
 * @typedef {{
 *   readonly capture: XhrCaptureSettings,
 *   readonly now: () => string,
 *   readonly tracePropagationTargets: readonly TracePropagationTarget[]
 * }} XhrWrapperSettings
 * @typedef {{ readonly args: readonly unknown[], readonly methods: XhrMethods, readonly settings: XhrWrapperSettings }} XhrSend
 */

const MIN_BYTES = 0;
const DECIMAL = 10;

/**
 * @param {unknown} xhr
 * @param {string} property
 * @returns {unknown}
 */
function readXhrResponseValue(xhr, property) {
  try {
    return readField(xhr, property);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isByteCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_BYTES;
}

/**
 * @param {unknown} response
 * @returns {number | undefined}
 */
function binaryResponseBytes(response) {
  if (response instanceof ArrayBuffer) {
    return response.byteLength;
  }
  if (ArrayBuffer.isView(response)) {
    return response.byteLength;
  }
  const size = readField(response, "size");
  return isByteCount(size) ? size : undefined;
}

/**
 * @param {unknown} xhr
 * @returns {number | undefined}
 */
function xhrResponseBodySizeBytes(xhr) {
  const responseType = readXhrResponseValue(xhr, "responseType");
  if (responseType === undefined || responseType === "" || responseType === "text") {
    const responseText = stringValue(readXhrResponseValue(xhr, "responseText"));
    if (responseText !== undefined) {
      return utf8ByteLength(responseText);
    }
  }
  const response = readXhrResponseValue(xhr, "response");
  const responseString = stringValue(response);
  return responseString === undefined ? binaryResponseBytes(response) : utf8ByteLength(responseString);
}

/**
 * @param {unknown} xhr
 * @param {boolean} measureXhrResponseBodySize
 * @returns {number | undefined}
 */
function xhrResponseSizeBytes(xhr, measureXhrResponseBodySize) {
  const getResponseHeader = readField(xhr, "getResponseHeader");
  if (!isCallable(getResponseHeader)) {
    return measureXhrResponseBodySize ? xhrResponseBodySizeBytes(xhr) : undefined;
  }
  const contentLength = Number.parseInt(toText(Reflect.apply(getResponseHeader, xhr, ["Content-Length"]) ?? ""), DECIMAL);
  if (Number.isFinite(contentLength) && contentLength >= MIN_BYTES) {
    return contentLength;
  }
  return measureXhrResponseBodySize ? xhrResponseBodySizeBytes(xhr) : undefined;
}

/**
 * @param {unknown} xhr
 * @returns {number | undefined}
 */
function xhrStatusCode(xhr) {
  const status = readField(xhr, "status");
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

/**
 * @param {XhrCaptureSettings} capture
 * @param {unknown} error
 * @returns {XhrCaptureSettings}
 */
function xhrErrorSettings(capture, error) {
  return {
    ...capture,
    measureXhrResponseBodySize: false,
    metadata: {
      ...capture.metadata,
      xhrErrorName: errorName(error),
      xhrErrorValueType: typeof error
    },
    status: "error"
  };
}

/**
 * @param {unknown} xhr
 * @param {unknown} url
 * @param {XhrSend} request
 * @returns {void}
 */
function propagateTraceparent(xhr, url, { methods, settings }) {
  if (indexRuntime.shouldPropagateTraceparent(url, settings.tracePropagationTargets)) {
    Reflect.apply(methods.setRequestHeader, xhr, ["traceparent", indexRuntime.createReactNativeTraceHeaders(settings.capture.trace).traceparent]);
  }
}

class XhrRequestState {
  /**
   * @param {string} method
   * @param {unknown} url
   */
  constructor(method, url) {
    this.method = method;
    this.reported = false;
    this.url = url;
    /** @type {string | undefined} */
    this.body = undefined;
    this.startedAtMs = Number.NaN;
    this.timestamp = "";
    /** @type {number | undefined} */
    this.responseStartAtMs = undefined;
  }

  /**
   * @param {unknown} xhr
   * @param {XhrSend} request
   * @returns {unknown}
   */
  send(xhr, { args, methods, settings }) {
    const [body] = args;
    this.body = stringValue(body);
    this.startedAtMs = settings.capture.nowMs();
    this.timestamp = settings.now();
    this.trackReadyState(xhr, settings.capture);
    propagateTraceparent(xhr, this.url, { args, methods, settings });
    try {
      return Reflect.apply(methods.send, xhr, args);
    } catch (error) {
      this.capture(xhr, xhrErrorSettings(settings.capture, error));
      throw error;
    }
  }

  /**
   * @returns {number | undefined}
   */
  responseStartDurationMs() {
    const { responseStartAtMs } = this;
    return responseStartAtMs === undefined ? undefined : elapsedMs(this.startedAtMs, () => responseStartAtMs);
  }

  /**
   * @param {unknown} xhr
   * @param {XhrCaptureSettings} settings
   * @returns {void}
   */
  capture(xhr, settings) {
    if (this.reported) {
      return;
    }
    this.reported = true;
    const durationMs = elapsedMs(this.startedAtMs, settings.nowMs);
    const responseStartDurationMs = this.responseStartDurationMs();
    const responseSizeBytes = xhrResponseSizeBytes(xhr, settings.measureXhrResponseBodySize);
    const routeTemplate = settings.routeTemplate ?? settings.routeTemplateFactory({ url: this.url });
    const statusCode = xhrStatusCode(xhr);
    indexRuntime.captureReactNativeResourceSpan(settings.client, {
      appState: settings.appState,
      durationMs,
      metadata: {
        ...metadataRuntime.createSafeReactNativeMetadata(settings.metadata, settings.metadataFactory, {
          durationMs,
          init: this.body === undefined ? undefined : { body: this.body },
          input: this.url,
          method: this.method,
          routeTemplate,
          status: settings.status ?? undefined,
          statusCode,
          url: this.url
        }),
        responseStartDurationMs,
        transport: "xhr"
      },
      method: this.method,
      platform: settings.platform,
      responseSizeBytes,
      routeTemplate,
      screen: settings.screen,
      sessionId: settings.sessionId,
      status: settings.status ?? undefined,
      statusCode,
      timestamp: this.timestamp,
      trace: settings.trace
    });
  }

  /**
   * @param {unknown} xhr
   * @param {XhrCaptureSettings} settings
   * @returns {void}
   */
  readyStateChanged(xhr, settings) {
    const readyState = readField(xhr, "readyState");
    if (readyState === settings.headersReceivedState && this.responseStartAtMs === undefined) {
      this.responseStartAtMs = settings.nowMs();
      return;
    }
    if (readField(xhr, "readyState") === settings.doneState && !this.reported) {
      this.capture(xhr, settings);
    }
  }

  /**
   * @param {unknown} xhr
   * @param {XhrCaptureSettings} settings
   * @returns {void}
   */
  trackReadyState(xhr, settings) {
    const { onReadyStateChange } = { onReadyStateChange: () => { this.readyStateChanged(xhr, settings); } };
    const addEventListener = readField(xhr, "addEventListener");
    if (isCallable(addEventListener)) {
      Reflect.apply(addEventListener, xhr, ["readystatechange", onReadyStateChange]);
      return;
    }
    const originalOnReadyStateChange = readField(xhr, "onreadystatechange");
    /**
     * @this {unknown}
     * @param {readonly unknown[]} args
     * @returns {unknown}
     */
    function logBrewOnReadyStateChange(...args) {
      onReadyStateChange();
      if (isCallable(originalOnReadyStateChange)) {
        return Reflect.apply(originalOnReadyStateChange, this, args);
      }
      return undefined;
    }
    if (isWritableRecord(xhr)) {
      xhr["onreadystatechange"] = logBrewOnReadyStateChange;
    }
  }
}

module.exports = { XhrRequestState };
