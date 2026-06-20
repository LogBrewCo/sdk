import sdk from "./index.cjs";

export const {
  createNetworkMilestoneAttributes,
  createProductActionAttributes,
  createSupportTicketDraft,
  createTraceparent,
  createTraceparentHeaders,
  createLogBrewPinoDestination,
  createLogBrewWinstonTransport,
  installLogBrewConsoleCapture,
  LogBrewClient,
  logAttributesFromConsoleArgs,
  logAttributesFromPinoRecord,
  logAttributesFromWinstonInfo,
  logbrewLevelFromConsoleMethod,
  parseTraceparent,
  RecordingTransport,
  SdkError,
  spanAttributesFromTraceparent,
  TransportError
} = sdk;

export default sdk;
