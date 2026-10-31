import {
  HOST,
  SERVER_ERROR,
  createLatch,
  createRecorder,
  finalErrorHandler,
  parseJson,
  readField,
  requestContext,
  traceparentFor
} from "./support.js";
import {
  createErrorEvent,
  createLogBrewExpressClient,
  createRequestEvent,
  createRequestMetricEvent,
  getActiveLogBrewTrace,
  logbrewErrorHandler,
  logbrewMiddleware,
  withLogBrewExpressHandler
} from "@logbrew/express";
import assert from "node:assert/strict";
import commonjsAdapter from "./commonjs.cjs";
import { connect } from "node:net";
import express from "express";
import { once } from "node:events";
import { readFile } from "node:fs/promises";

/**
 * @import { Express, NextFunction, Request, Response, Router } from "express"
 * @import { LogBrewExpressErrorHandlerOptions, LogBrewExpressOptions } from "@logbrew/express"
 * @import { LogBrewTraceContext } from "@logbrew/node"
 * @import { LogBrewClient } from "@logbrew/sdk"
 * @import { Latch, Recorder } from "./support.js"
 * @typedef {{
 *   readonly aborted?: boolean,
 *   readonly commonjs?: boolean,
 *   readonly failure?: boolean,
 *   readonly overlap?: boolean,
 *   readonly overrides?: boolean,
 *   readonly pattern?: string
 * }} Scenario
 * @typedef {{
 *   readonly createErrorEvent: typeof createErrorEvent,
 *   readonly createLogBrewExpressClient: typeof createLogBrewExpressClient,
 *   readonly createRequestEvent: typeof createRequestEvent,
 *   readonly createRequestMetricEvent: typeof createRequestMetricEvent,
 *   readonly getActiveLogBrewTrace: typeof getActiveLogBrewTrace,
 *   readonly logbrewErrorHandler: typeof logbrewErrorHandler,
 *   readonly logbrewMiddleware: typeof logbrewMiddleware,
 *   readonly withLogBrewExpressHandler: typeof withLogBrewExpressHandler
 * }} Adapter
 * @typedef {Readonly<Record<string, unknown>>} Mount
 * @typedef {{
 *   readonly baseUrl: unknown,
 *   readonly client: LogBrewClient,
 *   readonly mountParameters: Mount | undefined,
 *   readonly originalUrl: string,
 *   readonly params: Readonly<Record<string, unknown>>,
 *   readonly routePath: unknown,
 *   readonly trace: LogBrewTraceContext | undefined
 * }} Probe
 * @typedef {{
 *   readonly captureFailures: readonly unknown[],
 *   readonly clients: readonly LogBrewClient[],
 *   readonly errors: readonly unknown[],
 *   readonly probes: readonly Probe[],
 *   readonly recordCaptureFailure: (error: unknown) => void,
 *   readonly recordClient: (client: LogBrewClient) => void,
 *   readonly recordError: (error: unknown) => void,
 *   readonly recordProbe: (probe: Probe) => void
 * }} MountedRecords
 * @typedef {{
 *   readonly api: Adapter,
 *   readonly count: number,
 *   readonly handlersReady: Latch,
 *   readonly mountOf: (req: Request) => Mount | undefined,
 *   readonly original: unknown,
 *   readonly pattern: string,
 *   readonly recorder: Recorder,
 *   readonly records: MountedRecords,
 *   readonly scenario: Scenario,
 *   readonly setMount: (req: Request, mount: Mount) => void,
 *   readonly template: string
 * }} MountedView
 */

const EXPRESS_MANIFEST_URL = new URL(import.meta.resolve("express/package.json"));
const EXPRESS_MANIFEST = parseJson(await readFile(EXPRESS_MANIFEST_URL, "utf8"));
const MANIFEST_VERSION = readField(EXPRESS_MANIFEST, "version");
const EXPRESS_VERSION = typeof MANIFEST_VERSION === "string" ? MANIFEST_VERSION : "";
const [MAJOR_TEXT = ""] = EXPRESS_VERSION.split(".");
const EXPRESS_5 = 5;
const MODERN_EXPRESS = Number(MAJOR_TEXT) >= EXPRESS_5;
const PATTERN = MODERN_EXPRESS ? "/orders{/:orderId}" : "/orders/:orderId?";
const TIMESTAMP = "2026-08-29T12:00:00Z";
const SERVER_API_KEY = "LOGBREW_SERVER_API_KEY";
const NOT_SAMPLED = "00";
const SCHEMA_VERSION = 1;
const ONE = 1;
const TWO = 2;
const esmAdapter = Object.freeze({
  createErrorEvent,
  createLogBrewExpressClient,
  createRequestEvent,
  createRequestMetricEvent,
  getActiveLogBrewTrace,
  logbrewErrorHandler,
  logbrewMiddleware,
  withLogBrewExpressHandler
});

/**
 * @param {number} count
 * @param {Latch} ready
 * @returns {MountedRecords}
 */
function createMountedRecords(count, ready) {
  /** @type {unknown[]} */
  const captureFailures = [];
  /** @type {LogBrewClient[]} */
  const clients = [];
  /** @type {unknown[]} */
  const errors = [];
  /** @type {Probe[]} */
  const probes = [];
  return {
    captureFailures,
    clients,
    errors,
    probes,
    recordCaptureFailure: (error) => {
      captureFailures.push(error);
    },
    recordClient: (client) => {
      clients.push(client);
    },
    recordError: (error) => {
      errors.push(error);
    },
    recordProbe: (probe) => {
      probes.push(probe);
      if (probes.length === count) {
        ready.open();
      }
    }
  };
}

/**
 * @param {Scenario} [scenario]
 * @returns {MountedView}
 */
function createMountedView(scenario = {}) {
  const count = scenario.overlap === true ? TWO : ONE;
  const pattern = scenario.pattern ?? PATTERN;
  const handlersReady = createLatch();
  /** @type {WeakMap<Request, Mount>} */
  const mounts = new WeakMap();
  return {
    api: scenario.commonjs === true ? commonjsAdapter : esmAdapter,
    count,
    handlersReady,
    mountOf: (req) => mounts.get(req),
    original: new TypeError("mounted handler failure"),
    pattern,
    recorder: createRecorder(),
    records: createMountedRecords(count, handlersReady),
    scenario,
    setMount: (req, mount) => {
      mounts.set(req, mount);
    },
    template: scenario.overrides === true ? "/approved/:itemId" : pattern
  };
}

/**
 * @param {MountedView} view
 * @returns {Pick<LogBrewExpressOptions, "requestEvent" | "requestMetricEvent">}
 */
function requestOverrides(view) {
  const { api, template } = view;
  return {
    requestEvent: (req, res, context) => {
      const event = api.createRequestEvent(req, res, context);
      const metadata = { ...event.attributes.metadata, routeTemplate: template };
      return { ...event, attributes: { ...event.attributes, metadata, name: `GET ${template}` } };
    },
    requestMetricEvent: (req, res, context) => {
      const event = api.createRequestMetricEvent(req, res, context);
      return { ...event, attributes: { ...event.attributes, metadata: { ...event.attributes.metadata, routeTemplate: template } } };
    }
  };
}

/**
 * @param {MountedView} view
 * @returns {LogBrewExpressOptions}
 */
function mountedMiddlewareOptions(view) {
  const { api, records } = view;
  return {
    captureRequestMetrics: true,
    client: () => {
      const client = api.createLogBrewExpressClient({
        context: { resource: { service: { name: "mounted-service" } }, schemaVersion: SCHEMA_VERSION },
        serverApiKey: SERVER_API_KEY
      });
      records.recordClient(client);
      return client;
    },
    now: () => TIMESTAMP,
    onCaptureError: records.recordCaptureFailure,
    transport: view.recorder.transport,
    ...(view.scenario.overrides === true ? requestOverrides(view) : {})
  };
}

/**
 * @param {MountedView} view
 * @returns {LogBrewExpressErrorHandlerOptions}
 */
function mountedErrorOptions(view) {
  const { api, template } = view;
  return {
    onCaptureError: view.records.recordCaptureFailure,
    ...(view.scenario.overrides === true ? {
      errorEvent: (error, context) => {
        const event = api.createErrorEvent(error, context.req, { trace: context.trace });
        const metadata = { ...event.attributes.metadata, routeTemplate: template };
        return { ...event, attributes: { ...event.attributes, metadata, title: `GET ${template} failed` } };
      }
    } : {})
  };
}

/**
 * @param {Request} req
 * @param {MountedView} view
 * @returns {Probe}
 */
function probeRequest(req, view) {
  const context = requestContext(req);
  assert.equal(context.client, context.logbrew);
  assert.equal(context.transport, view.recorder.transport);
  return {
    baseUrl: readField(req, "baseUrl"),
    client: context.client,
    mountParameters: view.mountOf(req),
    originalUrl: req.originalUrl,
    params: { ...req.params },
    routePath: readField(req.route, "path"),
    trace: view.api.getActiveLogBrewTrace()
  };
}

/**
 * @param {Response} res
 * @param {boolean} aborted
 * @returns {void}
 */
function flushFirstChunk(res, aborted) {
  if (aborted) {
    res.write("first chunk");
    res.flushHeaders();
  }
}

/**
 * @param {Response} res
 * @param {boolean} aborted
 * @returns {void}
 */
function endUnlessAborted(res, aborted) {
  if (!aborted) {
    res.end("ok");
  }
}

/**
 * @param {MountedView} view
 * @returns {(req: Request, res: Response) => Promise<void>}
 */
function createProbeHandler(view) {
  const { scenario } = view;
  return async (req, res) => {
    const probe = probeRequest(req, view);
    view.records.recordProbe(probe);
    await view.handlersReady.wait();
    assert.deepEqual(view.api.getActiveLogBrewTrace(), probe.trace);
    flushFirstChunk(res, scenario.aborted === true);
    if (scenario.failure === true) {
      throw view.original;
    }
    endUnlessAborted(res, scenario.aborted === true);
  };
}

/**
 * @param {MountedView} view
 * @param {string} name
 * @returns {(req: Request, res: Response, next: NextFunction) => void}
 */
function rememberMount(view, name) {
  return (req, _res, next) => {
    view.setMount(req, { ...view.mountOf(req), [name]: req.params[name] });
    next();
  };
}

/**
 * @param {MountedView} view
 * @returns {Router}
 */
function createTenantRouter(view) {
  const tenantRouter = express.Router({ mergeParams: true });
  const regionRouter = express.Router({ mergeParams: true });
  regionRouter.get(view.pattern, view.api.withLogBrewExpressHandler(createProbeHandler(view)));
  tenantRouter.use("/regions/:regionId", rememberMount(view, "regionId"));
  tenantRouter.use("/regions/:regionId", regionRouter);
  return tenantRouter;
}

/**
 * @param {MountedView} view
 * @returns {Express}
 */
function createMountedApp(view) {
  const app = express();
  app.use(view.api.logbrewMiddleware(mountedMiddlewareOptions(view)));
  app.use("/tenants/:tenantId", rememberMount(view, "tenantId"));
  app.use("/tenants/:tenantId", createTenantRouter(view));
  app.use(view.api.logbrewErrorHandler(mountedErrorOptions(view)));
  app.use(finalErrorHandler((forwarded, res) => {
    view.records.recordError(forwarded);
    if (res.headersSent) {
      res.destroy();
    } else {
      res.status(SERVER_ERROR).end("failed");
    }
  }));
  return app;
}

/**
 * @param {number} port
 * @param {number} index
 * @param {string} pattern
 * @returns {string}
 */
function mountedRequestText(port, index, pattern) {
  const at = String(index);
  const route = pattern.startsWith("/members/") ? "members" : "orders";
  const path = `/tenants/private-tenant-${at}%2Fpart/regions/private-region-${at}%40part/${route}/private-item-${at}%23part%3Fpart?search=private-query-${at}#private-fragment-${at}`;
  const target = `http://private-user:private-pass@localhost:${String(port)}${path}`;
  return `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAuthorization: private-authorization\r\nCookie: private-cookie\r\ntraceparent: ${traceparentFor(index, NOT_SAMPLED)}\r\n\r\n`;
}

/**
 * @param {string} response
 * @param {Scenario} scenario
 * @returns {boolean}
 */
function responseDone(response, scenario) {
  return scenario.aborted === true || (response.includes("\r\n\r\n") && response.includes(scenario.failure === true ? "failed" : "ok"));
}

/**
 * @param {number} port
 * @param {number} index
 * @param {MountedView} view
 * @returns {Promise<string>}
 */
async function readMountedResponse(port, index, view) {
  const socket = connect(port, HOST);
  const closed = once(socket, "close");
  let response = "";
  socket.once("connect", () => {
    socket.write(mountedRequestText(port, index, view.pattern));
  });
  socket.on("data", (chunk) => {
    response += chunk.toString();
    if (responseDone(response, view.scenario)) {
      socket.destroy();
    }
  });
  socket.on("end", () => {
    socket.destroy();
  });
  await closed;
  return response;
}

/**
 * @param {number} port
 * @param {number} index
 * @param {MountedView} view
 * @returns {Promise<void>}
 */
async function sendMountedRequest(port, index, view) {
  const { scenario } = view;
  const aborted = scenario.aborted === true;
  const status = scenario.failure === true ? "500" : "200";
  try {
    const response = await readMountedResponse(port, index, view);
    assert.ok(aborted || response.startsWith(`HTTP/1.1 ${status} `), "mounted route returned an unexpected status");
  } catch (error) {
    if (!aborted) {
      throw error;
    }
  }
}

export { EXPRESS_VERSION, MODERN_EXPRESS, createMountedApp, createMountedView, sendMountedRequest };
