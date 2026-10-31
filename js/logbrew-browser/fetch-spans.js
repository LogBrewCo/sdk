import {
  assertBrowserContext,
  browserMetadata,
  browserPath,
  defaultSanitizeMetadata,
  defaultWindow,
  flushAfterCapture,
  mergeMetadata
} from "./browser-events.js";
import {
  createAutomaticBrowserEventId,
  createBrowserTraceContext,
  optionalBrowserTraceContext,
  resolveTraceContext
} from "./trace-context.js";
import {
  durationSince,
  errorType,
  fetchDetails,
  fetchMetadata,
  fetchMethod,
  nonNegativeIntegerOrUndefined,
  nowMs,
  responseBodySize,
  shouldCaptureRequest,
  traceparentFromTraceContext,
  validateTargets
} from "./network-spans.js";
import { headersWithTraceparent, requestHeaders, requestUrl, shouldPropagateTraceparent } from "./traceparent-fetch.js";
import { isRecord, readField } from "./values.js";
import { SdkError } from "@logbrew/sdk";

/**
 * @import { SpanAttributes, TransportResponse } from "@logbrew/sdk"
 * @import {
 *   BrowserFetchInput,
 *   BrowserFetchInstrumentation,
 *   BrowserFetchOptions,
 *   BrowserTraceContext,
 *   BrowserTraceContextInput,
 *   LogBrewBrowserContext,
 *   LogBrewBrowserEvent
 * } from "./index.js"
 * @typedef {BrowserFetchOptions & { readonly spanTraceContext?: BrowserTraceContextInput | undefined }} FetchSpanOptions
 * @typedef {{
 *   readonly init: RequestInit | undefined,
 *   readonly input: RequestInfo | URL,
 *   readonly method: string,
 *   readonly url: string
 * }} FetchRequest
 * @typedef {{
 *   readonly context: LogBrewBrowserContext,
 *   readonly options: BrowserFetchOptions,
 *   readonly parentTraceContext: BrowserTraceContext | undefined,
 *   readonly request: FetchRequest,
 *   readonly shouldCapture: boolean,
 *   readonly spanTraceContext: BrowserTraceContext,
 *   readonly startMs: number,
 *   readonly tracePropagated: boolean
 * }} FetchCall
 */

/**
 * @returns {string}
 */
function currentTimestamp() {
  return new Date().toISOString();
}

/**
 * @param {{ readonly message?: string | undefined, readonly path: string }} context
 * @returns {string}
 */
function defaultFetchSpanEventId({ message, path }) {
  return createAutomaticBrowserEventId("evt_browser_fetch", `${path}_${message}`);
}

/**
 * @param {RequestInfo | URL} input
 * @param {RequestInit | undefined} init
 * @returns {FetchRequest}
 */
function fetchRequest(input, init) {
  return {
    init,
    input,
    method: fetchMethod(input, init),
    url: requestUrl(input)
  };
}

/**
 * @param {BrowserTraceContext | undefined} traceContext
 * @returns {BrowserTraceContext}
 */
function requireSpanTraceContext(traceContext) {
  if (traceContext === undefined) {
    throw new TypeError("Cannot read properties of undefined (reading 'spanId')");
  }
  return traceContext;
}

/**
 * @param {BrowserFetchInput} request
 * @param {Window} [browserWindow]
 * @param {FetchSpanOptions} [options]
 * @returns {LogBrewBrowserEvent<SpanAttributes>}
 */
function createBrowserFetchSpanEvent(request, browserWindow = defaultWindow(), {
  idFactory = defaultFetchSpanEventId,
  includeDocumentTitle = false,
  includeHash = false,
  includeQueryString = false,
  includeUserAgent = false,
  metadata,
  now = currentTimestamp,
  randomValues,
  resourcePathTemplate,
  sampled,
  sanitizeMetadata = defaultSanitizeMetadata,
  spanTraceContext,
  traceContext,
  traceFlags
} = {}) {
  if (!isRecord(request)) {
    throw new SdkError("configuration_error", "createBrowserFetchSpanEvent requires a fetch request summary");
  }
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
  const details = fetchDetails(request, resourcePathTemplate);
  const parentTraceContext = optionalBrowserTraceContext(traceContext);
  const childTraceContext = requireSpanTraceContext(optionalBrowserTraceContext(spanTraceContext ?? request.spanTraceContext ?? createBrowserTraceContext({
    randomValues,
    sampled: parentTraceContext?.sampled ?? sampled,
    traceFlags: parentTraceContext?.traceFlags ?? traceFlags,
    traceId: parentTraceContext?.traceId
  })));
  const baseMetadata = browserMetadata(browserWindow, { includeDocumentTitle, includeUserAgent, path, source: "browser.fetch" });
  const safeMetadata = sanitizeMetadata(mergeMetadata(mergeMetadata(baseMetadata, metadata), fetchMetadata(details)), "fetch");
  return {
    id: idFactory({ browserWindow, message: `${details.method} ${details.requestPath}`, path, request, source: "fetch" }),
    timestamp: now(),

    attributes: {
      durationMs: details.durationMs,
      metadata: safeMetadata,
      name: `browser.fetch ${details.method} ${details.requestPath}`,
      ...(parentTraceContext === undefined ? {} : { parentSpanId: parentTraceContext.spanId }),
      spanId: childTraceContext.spanId,
      status: details.status,
      traceId: childTraceContext.traceId
    }
  };
}

/**
 * @param {BrowserFetchInput} request
 * @param {LogBrewBrowserContext} context
 * @param {FetchSpanOptions} [options]
 * @returns {Promise<TransportResponse | undefined>}
 */
async function captureBrowserFetchSpan(request, context, options = {}) {
  assertBrowserContext(context, "captureBrowserFetchSpan");
  const eventOptions = { ...options, traceContext: resolveTraceContext(context, options) };
  const event = createBrowserFetchSpanEvent(request, context.browserWindow, eventOptions);

  context.client.span(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

/**
 * @param {() => BrowserFetchInput} request
 * @param {LogBrewBrowserContext} context
 * @param {FetchSpanOptions} options
 * @returns {Promise<TransportResponse | undefined>}
 */
async function captureFetchOutcome(request, context, options) {
  try {
    return await captureBrowserFetchSpan(request(), context, {
      ...options,
      onCaptureError: undefined,
      raiseCaptureErrors: true
    });
  } catch (error) {
    if (typeof options.onCaptureError === "function") {
      try {
        await options.onCaptureError(error, context, { reason: "capture" });
      } catch (callbackError) {
        if (options.raiseCaptureErrors === true) {
          throw callbackError;
        }
      }
    }
    if (options.raiseCaptureErrors === true) {
      throw error;
    }
    return undefined;
  }
}

/**
 * @param {FetchCall} call
 * @param {(durationMs: number) => BrowserFetchInput} outcome
 * @returns {Promise<TransportResponse | undefined>}
 */
async function captureCall(call, outcome) {
  return captureFetchOutcome(
    () => outcome(durationSince(call.startMs, call.options)),
    call.context,
    { ...call.options, traceContext: call.parentTraceContext }
  );
}

/**
 * @param {FetchCall} call
 * @param {unknown} error
 * @returns {Promise<undefined>}
 */
async function captureFailure(call, error) {
  if (!call.shouldCapture) {
    return undefined;
  }
  try {
    await captureCall(call, (durationMs) => ({
      ...call.request,
      durationMs,
      errorType: errorType(error),
      spanTraceContext: call.spanTraceContext,
      tracePropagated: call.tracePropagated
    }));
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * @param {FetchCall} call
 * @param {Response} response
 * @returns {Promise<void>}
 */
async function captureResponse(call, response) {
  if (!call.shouldCapture) {
    return;
  }
  await captureCall(call, (durationMs) => ({
    ...call.request,
    durationMs,
    responseBodySize: responseBodySize(response),
    spanTraceContext: call.spanTraceContext,
    statusCode: nonNegativeIntegerOrUndefined(readField(response, "status")),
    tracePropagated: call.tracePropagated
  }));
}

/**
 * @param {LogBrewBrowserContext} context
 * @param {BrowserFetchOptions} options
 * @param {FetchRequest} request
 * @returns {FetchCall}
 */
function beginFetchCall(context, options, request) {
  const shouldCapture = shouldCaptureRequest(request.url, options.captureTargets);
  const startMs = nowMs(options);
  const parentTraceContext = resolveTraceContext(context, options);
  const spanTraceContext = createBrowserTraceContext({
    randomValues: options.randomValues,
    sampled: parentTraceContext?.sampled ?? options.sampled,
    traceFlags: parentTraceContext?.traceFlags ?? options.traceFlags,
    traceId: parentTraceContext?.traceId
  });
  const tracePropagated = shouldPropagateTraceparent(request.url, options.tracePropagationTargets ?? []);
  return { context, options, parentTraceContext, request, shouldCapture, spanTraceContext, startMs, tracePropagated };
}

/**
 * @param {FetchCall} call
 * @returns {RequestInit | undefined}
 */
function nextFetchInit({ request: { init, input }, spanTraceContext, tracePropagated }) {
  if (!tracePropagated) {
    return init;
  }
  const requestInit = init ?? {};
  return {
    ...requestInit,
    headers: headersWithTraceparent(requestHeaders(input, requestInit), traceparentFromTraceContext(spanTraceContext))
  };
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {FetchCall} call
 * @param {RequestInit | undefined} nextInit
 * @returns {Promise<Response>}
 */
async function performFetch(fetchImpl, call, nextInit) {
  try {
    return await fetchImpl(call.request.input, nextInit);
  } catch (error) {
    await captureFailure(call, error);
    throw error;
  }
}

/**
 * @param {unknown} value
 * @returns {value is typeof fetch}
 */
function isFetch(value) {
  return typeof value === "function";
}

/**
 * @param {LogBrewBrowserContext} context
 * @param {BrowserFetchOptions} [options]
 * @returns {typeof fetch}
 */
function createLogBrewBrowserFetch(context, options = {}) {
  assertBrowserContext(context, "createLogBrewBrowserFetch");
  const fetchImpl = options.fetchImpl ?? readField(context.browserWindow, "fetch") ?? readField(globalThis, "fetch");
  if (!isFetch(fetchImpl)) {
    throw new SdkError("configuration_error", "createLogBrewBrowserFetch requires fetch");
  }
  validateTargets(options.tracePropagationTargets ?? [], "tracePropagationTargets");
  validateTargets(options.captureTargets, "captureTargets", { optional: true });
  return async function logbrewBrowserFetch(input, init) {
    const call = beginFetchCall(context, options, fetchRequest(input, init));
    const response = await performFetch(fetchImpl, call, nextFetchInit(call));
    await captureResponse(call, response);
    return response;
  };
}

/**
 * @param {LogBrewBrowserContext} context
 * @param {BrowserFetchOptions} [options]
 * @returns {BrowserFetchInstrumentation}
 */
function installLogBrewBrowserFetchInstrumentation(context, options = {}) {
  assertBrowserContext(context, "installLogBrewBrowserFetchInstrumentation");
  const browserWindow = options.browserWindow ?? context.browserWindow ?? defaultWindow();
  const originalFetch = readField(browserWindow, "fetch");
  if (browserWindow === undefined || !isFetch(originalFetch)) {
    throw new SdkError("configuration_error", "installLogBrewBrowserFetchInstrumentation requires window.fetch");
  }
  const wrappedFetch = createLogBrewBrowserFetch(context, {
    ...options,
    browserWindow,
    fetchImpl: async (input, init) => originalFetch.call(browserWindow, input, init)
  });
  browserWindow.fetch = wrappedFetch;
  return {
    uninstall() {
      if (browserWindow.fetch === wrappedFetch) {
        browserWindow.fetch = originalFetch;
      }
    }
  };
}

export {
  captureBrowserFetchSpan,
  createBrowserFetchSpanEvent,
  createLogBrewBrowserFetch,
  installLogBrewBrowserFetchInstrumentation
};
