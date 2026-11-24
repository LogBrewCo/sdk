import type {
  DroppedEvent,
  EventStore,
  LogBrewClient,
  TelemetryContext,
  Transport
} from "@logbrew/sdk";

type ReactNativePlatformLike = {
  OS?: string;
  Version?: string | number;
  isPad?: boolean;
  constants?: { isTesting?: boolean; [key: string]: unknown };
};

type ReactNativeAppStateLike = {
  currentState?: string | null | undefined;
  addEventListener?: (
    type: "change",
    listener: (state: string) => void
  ) => { remove(): void } | (() => void);
};

type CreateLogBrewReactNativeClientConfig = {
  automaticDelivery?: boolean;
  apiKey?: string;
  clientKey?: string;
  context?: TelemetryContext;
  /** Automatic delivery interval in milliseconds. Defaults to 1000. */
  deliveryIntervalMs?: number;
  deliveryQueueThreshold?: number;
  /** Advanced synchronous persistence seam. React Native apps normally use the native entry's persistentQueue mode. */
  eventStore?: EventStore;
  maxBatchBytes?: number;
  maxBatchEvents?: number;
  maxQueueBytes?: number;
  maxQueueSize?: number;
  maxRetries?: number;
  onEventDropped?: (drop: DroppedEvent) => void;
  sdkName?: string;
  sdkVersion?: string;
  /**
   * Adds `context.session.id` to every event. The app keeps 1 session ID in memory.
   * It ends after 30 minutes without events or 4 hours after it starts. `false` sends no session ID. A `session` in `context` replaces it.
   */
  session?: boolean;
  transport?: Transport;
};

type ReactNativeFetchResponseLike = {
  status: number;
  headers?: {
    get(name: string): string | null | undefined;
  };
};

type ReactNativeFetchLike = (
  endpoint: string,
  init: {
    body: string;
    headers: Record<string, string>;
    method: "POST";
  }
) => Promise<ReactNativeFetchResponseLike> | ReactNativeFetchResponseLike;

type ReactNativeFetchTransportConfig = {
  endpoint?: string;
  fetchImpl?: ReactNativeFetchLike;
  headers?: Record<string, string>;
};

declare function createLogBrewReactNativeClient(
  config: CreateLogBrewReactNativeClientConfig
): LogBrewClient;
declare function createReactNativeFetchTransport(
  config?: ReactNativeFetchTransportConfig
): Transport;

export type {
  CreateLogBrewReactNativeClientConfig,
  ReactNativeAppStateLike,
  ReactNativeFetchLike,
  ReactNativeFetchResponseLike,
  ReactNativeFetchTransportConfig,
  ReactNativePlatformLike
};
export {
  createLogBrewReactNativeClient,
  createReactNativeFetchTransport
};
