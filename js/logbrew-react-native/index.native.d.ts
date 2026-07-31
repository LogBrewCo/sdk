import type { EventStore, LogBrewClient } from "@logbrew/sdk";
import type { CreateLogBrewReactNativeClientConfig } from "./index.js";

export * from "./index.js";
export {
  installLogBrewReactNativeGlobalErrorHandler,
  installLogBrewReactNativePromiseRejectionTracker
} from "./global-errors";

export type ReactNativePersistentQueueMode = "auto" | "required" | "disabled";

export type CreateNativeLogBrewReactNativeClientConfig =
  Omit<CreateLogBrewReactNativeClientConfig, "eventStore"> & ({
    /**
     * `auto` uses the linked app-private native queue when available and otherwise uses memory.
     * `required` fails client creation when the native queue is unavailable. `disabled` uses memory.
     */
    persistentQueue?: ReactNativePersistentQueueMode;
    eventStore?: undefined;
  } | {
    /** Advanced app-owned synchronous persistence adapter. Mutually exclusive with persistentQueue. */
    eventStore: EventStore;
    persistentQueue?: never;
  });

export declare function createLogBrewReactNativeClient(
  config: CreateNativeLogBrewReactNativeClientConfig
): LogBrewClient;

export declare function createDefaultLogBrewReactNativeClient(
  config: CreateNativeLogBrewReactNativeClientConfig
): LogBrewClient;

export declare function purgeLogBrewReactNativePersistentQueue(
  config: { apiKey?: string; clientKey?: string }
): void;

declare const defaultExport: Omit<
  typeof import("./index.js").default,
  "createLogBrewReactNativeClient" | "createDefaultLogBrewReactNativeClient"
> & {
  createLogBrewReactNativeClient: typeof createLogBrewReactNativeClient;
  createDefaultLogBrewReactNativeClient: typeof createDefaultLogBrewReactNativeClient;
  purgeLogBrewReactNativePersistentQueue: typeof purgeLogBrewReactNativePersistentQueue;
};

export default defaultExport;
