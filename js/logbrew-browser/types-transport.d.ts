import type { DroppedEvent, TelemetryContext, Transport, TransportResponse } from "@logbrew/sdk";

type CreateLogBrewBrowserClientConfig = {
  apiKey?: string | undefined;
  /** Low-entropy browser context source. Defaults to the active browser navigator. */
  browserNavigator?: {
    readonly userAgentData?: {
      readonly brands?: readonly { readonly brand?: string; readonly version?: string }[];
      readonly mobile?: boolean;
      readonly platform?: string;
    };
  };
  /** Add low-entropy browser brand/version, platform, and device-family context. Defaults to true. */
  captureRuntimeContext?: boolean | undefined;
  clientKey?: string | undefined;
  context?: TelemetryContext | undefined;
  /** Deployment scope applied to every captured signal. */
  environment?: string | undefined;
  release?: string | undefined;
  /** Service scope applied to every captured signal. */
  service?: string | undefined;
  sdkName?: string | undefined;
  sdkVersion?: string | undefined;
  /** Retry attempts after the first send. Must be a non-negative integer. */
  maxRetries?: number | undefined;
  maxQueueBytes?: number | undefined;
  maxQueueSize?: number | undefined;
  maxBatchEvents?: number | undefined;
  /** Maximum UTF-8 request bytes. Defaults to the 64 KiB keepalive transport limit. */
  maxBatchBytes?: number | undefined;
  onEventDropped?: ((drop: DroppedEvent) => void) | undefined;
};

type FetchTransportConfig = {
  endpoint?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  headers?: Record<string, string> | undefined;
  /** Use bounded fetch keepalive. Defaults to true and is required for page-exit lifecycle delivery. */
  keepalive?: boolean | undefined;
  /** Maximum UTF-8 body bytes accepted by keepalive delivery. Defaults to 64 KiB. */
  maxKeepaliveBodyBytes?: number | undefined;
};

type BeaconTransportConfig = {
  endpoint: string;
  fetchImpl?: typeof fetch | undefined;
  maxBeaconBodyBytes?: number | undefined;
  sendBeacon?: ((endpoint: string, payload: string | Blob) => boolean) | undefined;
};

type BeaconTransportResponse = TransportResponse & {
  queued: boolean;
};

type BeaconTransport = Transport & {
  send: (apiKey: string, body: string) => Promise<BeaconTransportResponse>;
};

type BrowserPersistentStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

type BrowserPersistError = {
  code:
    | "persisted_batch_too_large"
    | "persisted_queue_full"
    | "persisted_storage_corrupt"
    | "persisted_storage_unavailable";
  message: string;
};

type BrowserPersistedReplay = {
  attempted: number;
  delivered: number;
  retained: number;
};

type BrowserPersistedReplayOptions = {
  skipOwnBatches?: boolean | undefined;
};

type BrowserPersistenceLockManager = {
  request: <Result>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => Promise<Result> | Result
  ) => Promise<Result>;
};

type PersistentBrowserTransport = Transport & {
  clearStoredBatches: () => void;
  pendingStoredBatches: () => number;
  replayStoredBatches: (apiKey: string, options?: BrowserPersistedReplayOptions) => Promise<BrowserPersistedReplay>;
};

type PersistentBrowserTransportConfig = {
  lockManager?: BrowserPersistenceLockManager | undefined;
  maxStoredBatches?: number | undefined;
  maxStoredBytes?: number | undefined;
  onPersistError?: ((error: BrowserPersistError) => void) | undefined;
  storage?: BrowserPersistentStorage | undefined;
  storageKey?: string | undefined;
  transport: Transport;
};

type TracePropagationTarget = string | RegExp | ((url: string) => boolean);

type BrowserTraceparentConfig = {
  traceId?: string | undefined;
  spanId?: string | undefined;
  traceFlags?: string | undefined;
  randomValues?: ((length: number) => ArrayLike<number>) | undefined;
};

type BrowserTraceContext = {
  traceId: string;
  spanId: string;
  traceFlags: string;
  sampled: boolean;
};

type BrowserTraceContextConfig = BrowserTraceparentConfig & {
  sampled?: boolean | undefined;
};

type BrowserTraceContextInput = BrowserTraceContext | BrowserTraceContextConfig | string | false | undefined;

type BrowserTraceContextSource = BrowserTraceContextInput | (() => BrowserTraceContextInput);

type TraceparentFetchConfig = {
  fetchImpl?: typeof fetch | undefined;
  randomValues?: ((length: number) => ArrayLike<number>) | undefined;
  traceContext?: BrowserTraceContextSource | undefined;
  traceFlags?: string | undefined;
  traceparent?: string | undefined;
  traceparentFactory?: undefined | ((context: {
    input: RequestInfo | URL;
    init?: RequestInit | undefined;
    url: string;
  }) => string | undefined);
  tracePropagationTargets?: TracePropagationTarget[] | undefined;
};

export type {
  BeaconTransport,
  BeaconTransportConfig,
  BeaconTransportResponse,
  BrowserPersistedReplay,
  BrowserPersistedReplayOptions,
  BrowserPersistenceLockManager,
  BrowserPersistentStorage,
  BrowserPersistError,
  BrowserTraceContext,
  BrowserTraceContextConfig,
  BrowserTraceContextInput,
  BrowserTraceContextSource,
  BrowserTraceparentConfig,
  CreateLogBrewBrowserClientConfig,
  FetchTransportConfig,
  PersistentBrowserTransport,
  PersistentBrowserTransportConfig,
  TraceparentFetchConfig,
  TracePropagationTarget
};
