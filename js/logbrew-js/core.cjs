const { installBrowserBreadcrumbs } = require("./browser-breadcrumbs.cjs");
const { LogBrewClient } = require("./client.cjs");
const { installLogBrewConsoleCapture } = require("./console-capture.cjs");
const { logAttributesFromConsoleArgs, logbrewLevelFromConsoleMethod } = require("./console-arguments.cjs");
const { createIssueAttributesFromError } = require("./error-issue.cjs");
const { compactMetadata, isMetadataValue } = require("./log-context.cjs");
const { createNetworkMilestoneAttributes } = require("./network-milestone.cjs");
const { buildOpenTelemetryHelpers } = require("./opentelemetry.cjs");
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
const {
  requireNonEmpty,
  requireSpanId,
  requireTraceId,
  stringOrUndefined
} = require("./validation.cjs");

const MAX_SPAN_EVENTS = 8;
const MAX_SPAN_LINKS = 8;

const {
  createLogBrewOpenTelemetrySpanExporter,
  createLogBrewOpenTelemetrySpanProcessor,
  logbrewTraceContextFromCurrentOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpanContext,
  spanAttributesFromOpenTelemetryReadableSpan
} = buildOpenTelemetryHelpers({
  LogBrewClient,
  SdkError,
  compactMetadata,
  isMetadataValue,
  maxSpanEvents: MAX_SPAN_EVENTS,
  maxSpanLinks: MAX_SPAN_LINKS,
  requireNonEmpty,
  requireSpanId,
  requireTraceId,
  stringOrUndefined
});

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
