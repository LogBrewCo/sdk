import type { ActionAttributes, EnvironmentAttributes, LogAttributes, MetricAttributes, ReleaseAttributes, SpanAttributes, TelemetryContext } from "./telemetry.js";
import type { DeliveryHealthSnapshot, DroppedEvent, EventFilter, EventStore, IssueAdmission, Transport, TransportResponse } from "./delivery.js";
import type { IssueAttributes, IssueBreadcrumbInput } from "./issues.js";

/** Buffered public client for validating, previewing, and flushing LogBrew events. */
declare class LogBrewClient {
  /** Create a client from public SDK identity, retry, and API key settings. */
  public static create(config: {
    apiKey: string;
    sdkName: string;
    sdkVersion: string;
    /** Versioned context merged into every captured event; event context can override dynamic fields. */
    context?: TelemetryContext;
    /** Retry attempts after the first send. Must be a non-negative integer; defaults to 2. */
    maxRetries?: number;
    eventFilter?: EventFilter;
    /** Maximum queued compact event bytes. Defaults to 4 MiB. */
    maxQueueBytes?: number;
    maxQueueSize?: number;
    /** Maximum events per request body. Defaults to 100. */
    maxBatchEvents?: number;
    /** Maximum UTF-8 request body bytes. Defaults to 256 KiB. */
    maxBatchBytes?: number;
    onEventDropped?: (drop: DroppedEvent) => void;
    /** Optional app-scoped persistence adapter. Methods must complete synchronously. */
    eventStore?: EventStore;
    /** Client-owned transport used by automatic delivery and by flush/shutdown when no argument is supplied. */
    transport?: Transport;
    /** Enable interval and queue-threshold delivery. Defaults to true when transport is supplied. */
    automaticDelivery?: boolean;
    /** One-shot delivery interval in milliseconds. Defaults to 1000 and must not exceed 60000. */
    deliveryIntervalMs?: number;
    /** Queue count that triggers delivery without waiting for the interval. Defaults to min(50, maxQueueSize). */
    deliveryQueueThreshold?: number;
  }): LogBrewClient;
  /** Return the queued event count currently buffered in memory. */
  public pendingEvents(): number;
  /** Return compact serialized event bytes currently buffered in memory. */
  public pendingBytes(): number;
  /** Return the number of events dropped because the bounded in-memory queue was full. */
  public droppedEvents(): number;
  /** Return a frozen, content-free snapshot of queue and delivery lifecycle health. */
  public deliveryHealth(): DeliveryHealthSnapshot;
  /** Return the queued event batch as stable, pretty-printed JSON. */
  public previewJson(): string;
  /** Purge queued events from memory and persistence while no delivery operation is active. */
  public purgePendingEvents(): number;
  /** Add one explicit privacy-bounded breadcrumb to the client's 64-entry issue history. */
  public addBreadcrumb(breadcrumb: IssueBreadcrumbInput, timestamp?: string): void;
  /** Clear the current issue breadcrumb history and return the number removed. */
  public clearBreadcrumbs(): number;
  public release(id: string, timestamp: string, attributes: ReleaseAttributes): void;
  public environment(id: string, timestamp: string, attributes: EnvironmentAttributes): void;
  public issue(id: string, timestamp: string, attributes: IssueAttributes): void;
  /** Capture once and report queue admission. Custom issue overrides run once and return unavailable. */
  public issueWithAdmission(id: string, timestamp: string, attributes: IssueAttributes): IssueAdmission;
  public log(id: string, timestamp: string, attributes: LogAttributes): void;
  public span(id: string, timestamp: string, attributes: SpanAttributes): void;
  public action(id: string, timestamp: string, attributes: ActionAttributes): void;
  public metric(id: string, timestamp: string, attributes: MetricAttributes): void;
  /** Flush one queue snapshot in bounded batches while preserving concurrent captures and retry bodies. */
  public flush(transport?: Transport): Promise<TransportResponse>;
  /** Reject new capture, flush queued events, then close; a failed flush reopens the intact remainder. */
  public shutdown(transport?: Transport): Promise<TransportResponse>;
}

export { LogBrewClient };
