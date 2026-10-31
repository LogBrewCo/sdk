const { installBrowserBreadcrumbs } = require("./browser-breadcrumbs.cjs");
const { LogBrewClient } = require("./client.cjs");
const { installLogBrewConsoleCapture } = require("./console-capture.cjs");
const { logAttributesFromConsoleArgs, logbrewLevelFromConsoleMethod } = require("./console-arguments.cjs");
const { createIssueAttributesFromError } = require("./error-issue.cjs");
const { createNetworkMilestoneAttributes } = require("./network-milestone.cjs");
const {
  createLogBrewOpenTelemetrySpanExporter,
  createLogBrewOpenTelemetrySpanProcessor,
  logbrewTraceContextFromCurrentOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpanContext,
  spanAttributesFromOpenTelemetryReadableSpan
} = require("./opentelemetry.cjs");
const { createLogBrewPinoDestination } = require("./pino-destination.cjs");
const { logAttributesFromPinoRecord } = require("./pino-record.cjs");
const {
  PRODUCT_ANALYTICS_KINDS,
  PRODUCT_ANALYTICS_SCHEMA_VERSION,
  createProductActionAttributes
} = require("./product-action.cjs");
const { RecordingTransport } = require("./recording-transport.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { spanAttributesFromTraceparent } = require("./span-validation.cjs");
const { createSupportTicketDraft } = require("./support-ticket.cjs");
const {
  createBaggage,
  createTraceContextHeaders,
  createTraceparent,
  createTraceparentHeaders,
  createTracestate,
  parseBaggage,
  parseTraceparent,
  parseTracestate
} = require("./trace-context.cjs");
const { TransportError } = require("./transport-error.cjs");

module.exports = {
  PRODUCT_ANALYTICS_KINDS,
  installBrowserBreadcrumbs,

  PRODUCT_ANALYTICS_SCHEMA_VERSION,
  createBaggage,
  createIssueAttributesFromError,
  createNetworkMilestoneAttributes,
  createProductActionAttributes,

  createLogBrewOpenTelemetrySpanExporter,
  createLogBrewOpenTelemetrySpanProcessor,
  createSupportTicketDraft,
  createTraceContextHeaders,
  createTraceparent,
  createTraceparentHeaders,
  createTracestate,

  createLogBrewPinoDestination,
  installLogBrewConsoleCapture,

  LogBrewClient,
  logbrewTraceContextFromCurrentOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpanContext,

  logAttributesFromConsoleArgs,
  logAttributesFromPinoRecord,
  logbrewLevelFromConsoleMethod,
  parseBaggage,
  parseTraceparent,
  parseTracestate,

  RecordingTransport,
  SdkError,
  spanAttributesFromOpenTelemetryReadableSpan,
  spanAttributesFromTraceparent,

  TransportError
};
