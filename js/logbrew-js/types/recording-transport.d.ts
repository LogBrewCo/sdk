import type { TransportResponse } from "./delivery.js";

/** Scripted transport for previewing, accepting, or failing queued event flushes. */
declare class RecordingTransport {
  public constructor(scriptedResponses?: ({ statusCode: number; retryAfterMs?: number; errorCode?: string } | Error)[]);
  /** Every request body sent through this transport instance. */
  public sentBodies: string[];
  /** Create a transport that accepts queued flushes with a 202 response. */
  public static alwaysAccept(): RecordingTransport;
  /** Return the most recent request body sent through this transport. */
  public lastBody(): string | null;
  public send(apiKey: string, body: string): Promise<TransportResponse>;
}

export { RecordingTransport };
