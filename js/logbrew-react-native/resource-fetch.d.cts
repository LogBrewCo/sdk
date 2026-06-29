import type { LogBrewClient, Metadata } from "@logbrew/sdk";
import type {
  ReactNativeAppStateLike,
  ReactNativePlatformLike,
  ReactNativeTraceInput,
  TracePropagationTarget
} from "./index.cjs";

export type ReactNativeResourceFetchOptions<TInput = unknown, TInit = unknown, TResponse = unknown> = {
  appState?: ReactNativeAppStateLike;
  fetchImpl?: (input: TInput, init?: TInit) => Promise<TResponse> | TResponse;
  metadata?: Metadata;
  metadataFactory?: (context: ReactNativeResourceFetchMetadataContext<TInput, TInit, TResponse>) => Metadata | undefined;
  now?: () => string;
  nowMs?: () => number;
  platform?: ReactNativePlatformLike;
  randomValues?: (length: number) => ArrayLike<number>;
  routeTemplate?: string;
  routeTemplateFactory?: (context: { input: TInput; init?: TInit; url: string }) => string | undefined;
  screen?: string;
  sessionId?: string;
  trace?: ReactNativeTraceInput;
  traceFlags?: string;
  tracePropagationTargets?: TracePropagationTarget[];
};

export type ReactNativeResourceFetchMetadataContext<TInput = unknown, TInit = unknown, TResponse = unknown> = {
  readonly durationMs?: number;
  readonly error?: unknown;
  readonly init?: TInit;
  readonly input: TInput;
  readonly method: string;
  readonly response?: TResponse;
  readonly routeTemplate?: string;
  readonly status?: string;
  readonly statusCode?: number;
  readonly url: string;
};

export declare function createReactNativeResourceFetch<TInput = unknown, TInit = unknown, TResponse = unknown>(
  client: LogBrewClient,
  options?: ReactNativeResourceFetchOptions<TInput, TInit, TResponse>
): (input: TInput, init?: TInit) => Promise<TResponse>;
