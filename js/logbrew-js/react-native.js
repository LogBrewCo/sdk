import sdk from "./core.cjs";

export const {
  PRODUCT_ANALYTICS_KINDS,
  PRODUCT_ANALYTICS_SCHEMA_VERSION,
  installBrowserBreadcrumbs,
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
} = sdk;

export { default } from "./core.cjs";
