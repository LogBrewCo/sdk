import type { ActionAttributes, EnvironmentAttributes, LogAttributes, MetricAttributes, ReleaseAttributes, SpanAttributes } from "./telemetry.js";
import type { IssueAttributes } from "./issues.js";

declare const DELIVERY_HEALTH_SCHEMA_VERSION = 1;

/** Public event union used in preview and transport payloads. */
type Event =
  | { type: "release"; id: string; timestamp: string; attributes: ReleaseAttributes }
  | { type: "environment"; id: string; timestamp: string; attributes: EnvironmentAttributes }
  | { type: "issue"; id: string; timestamp: string; attributes: IssueAttributes }
  | { type: "log"; id: string; timestamp: string; attributes: LogAttributes }
  | { type: "span"; id: string; timestamp: string; attributes: SpanAttributes }
  | { type: "action"; id: string; timestamp: string; attributes: ActionAttributes }
  | { type: "metric"; id: string; timestamp: string; attributes: MetricAttributes };

/** Drop-only event filter called after validation and before an event is queued. */
type EventFilter = (event: Event) => boolean | void;

/** Canonical compact event record exchanged with an app-owned synchronous persistence adapter. */
type StoredEvent = {
  event: Event;
  serializedEvent: string;
  eventBytes: number;
};

/** Explicit synchronous persistence seam used to recover and acknowledge queued events safely. */
type EventStore = {
  load(): StoredEvent[];
  append(record: StoredEvent): void;
  acknowledge(count: number): void;
  /** Removes the records at ascending `load()` indexes; without it, fatal issues cannot evict queued events. */
  remove?(indexes: number[]): void;
  purge(): void;
  close(): void;
};

/** Queue drop notification emitted when a bounded in-memory queue is full. */
type DroppedEvent = {
  reason: "event_too_large" | "evicted_for_fatal" | "queue_bytes_overflow" | "queue_overflow";
  eventType: Event["type"];
  eventId: string;
  droppedEvents: number;
};

/** Stable transport response returned from flush and shutdown operations. */
type TransportResponse = {
  /** Final HTTP-like status returned by the transport. */
  statusCode: number;
  /** Number of transport attempts used for the flush. */
  attempts: number;
  /** Number of distinct batches acknowledged; client flush/shutdown responses always include it. */
  batches?: number;
  /** Optional retry delay from a rate-limit response, in milliseconds. */
  retryAfterMs?: number;
  /** Optional `code` from a 429 response body, such as `rate_limited` or `usage_limit_exceeded`. */
  errorCode?: string;
};

/** Minimal transport interface accepted by flush and shutdown operations. */
type Transport = {
  send(apiKey: string, body: string): TransportResponse | Promise<TransportResponse>;
};

/** Content-free bounded delivery state with no event or sensitive transport fields. */
type DeliveryHealthSnapshot = Readonly<{
  /** Stable schema discriminator for JSON consumers. */
  schemaVersion: typeof DELIVERY_HEALTH_SCHEMA_VERSION;
  automaticDelivery: boolean;
  lifecycle: "active" | "shutting_down" | "closed";
  deliveryState: "idle" | "queued" | "scheduled" | "in_flight" | "retrying" | "paused" | "accepted" | "failed" | "dropped";
  storage: "memory" | "persistent";
  queueEvents: number;
  queueBytes: number;
  /** Events and compact bytes loaded from persistence when this client started. */
  hydratedEvents: number;
  hydratedBytes: number;
  droppedEvents: number;
  droppedByReason: Readonly<{
    event_too_large: number;
    evicted_for_fatal: number;
    queue_bytes_overflow: number;
    queue_overflow: number;
  }>;
  lastDropReason: "none" | "event_too_large" | "evicted_for_fatal" | "queue_bytes_overflow" | "queue_overflow";
  scheduled: boolean;
  inFlight: boolean;
  coalesced: boolean;
  pendingOperations: number;
  lastOutcome: "idle" | "empty" | "accepted" | "failed";
  lastStatusClass: "none" | "success" | "client_error" | "server_error" | "network_error" | "transport_error" | "invalid_response" | "other_status";
  pausedReason: "none" | "authentication" | "rate_limit" | "non_retryable";
  consecutiveFailures: number;
  /** Bounded transient retry delay; zero when no automatic retry is scheduled. */
  retryDelayMs: number;
  flushes: number;
  failures: number;
  attempts: number;
  batches: number;
  /** Events durably acknowledged since this client was created. */
  acceptedEvents: number;
  /** Bounded monotonic-within-client Unix milliseconds; zero until the transition occurs. */
  lastAttemptAtUnixMs: number;
  lastAcceptedAtUnixMs: number;
  lastDroppedAtUnixMs: number;
}>;

/** Synchronous queue admission only; this result does not report delivery or retention. */
type IssueAdmission = Readonly<
  | { status: "admitted" }
  | { status: "filtered" }
  | { status: "dropped"; reason: DroppedEvent["reason"] }
  | { status: "unavailable" }
>;

export type {
  DeliveryHealthSnapshot,
  DroppedEvent,
  Event,
  EventFilter,
  EventStore,
  IssueAdmission,
  StoredEvent,
  Transport,
  TransportResponse
};
