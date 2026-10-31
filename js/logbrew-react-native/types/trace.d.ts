import type { Metadata, SpanAttributes } from "@logbrew/sdk";

type TracePropagationTarget = string | RegExp | ((url: string) => boolean);

type ReactNativeTraceparentConfig = {
  traceId?: string;
  spanId?: string;
  traceFlags?: string;
  randomValues?: (length: number) => ArrayLike<number>;
};

type ReactNativeTraceContext = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: string;
  sampled: boolean;
};

type ReactNativeTraceInput = ReactNativeTraceContext | string;

type ReactNativeTraceContextConfig = ReactNativeTraceparentConfig & {
  parentSpanId?: string;
  traceparent?: string;
};

type ReactNativeSpanAttributesInput = {
  durationMs?: number;
  metadata?: Metadata;
  name?: string;
  spanId?: string;
  status?: SpanAttributes["status"];
  trace?: ReactNativeTraceInput;
};

type TraceparentFetchLike<TResponse = unknown> = (
  input: any,
  init?: any
) => Promise<TResponse> | TResponse;

type TraceparentFetchConfig<TResponse = unknown> = {
  fetchImpl?: TraceparentFetchLike<TResponse>;
  randomValues?: (length: number) => ArrayLike<number>;
  trace?: ReactNativeTraceInput;
  traceFlags?: string;
  traceparent?: string;
  traceparentFactory?: (context: {
    input: any;
    init?: any;
    url: string;
  }) => string | undefined;
  tracePropagationTargets?: TracePropagationTarget[];
};

declare function createReactNativeTraceparent(config?: ReactNativeTraceparentConfig): string;
declare function createReactNativeTraceContext(
  config?: ReactNativeTraceContextConfig
): ReactNativeTraceContext;
declare function getActiveLogBrewTrace(): ReactNativeTraceContext | undefined;
declare function withLogBrewTrace<TResult>(
  trace: ReactNativeTraceInput | undefined,
  operation: (trace: ReactNativeTraceContext) => TResult
): TResult;
declare function bindLogBrewTrace<TArgs extends unknown[], TResult>(
  trace: ReactNativeTraceInput | undefined,
  operation: (...args: TArgs) => TResult
): (...args: TArgs) => TResult;
declare function getReactNativeTraceMetadata(trace?: ReactNativeTraceInput): Metadata;
declare function createReactNativeSpanAttributes(
  input?: ReactNativeSpanAttributesInput
): SpanAttributes;
declare function createReactNativeTraceHeaders(
  trace?: ReactNativeTraceInput
): { traceparent: string };
declare function createTraceparentFetch<TResponse = unknown>(
  config?: TraceparentFetchConfig<TResponse>
): TraceparentFetchLike<TResponse>;
declare function shouldPropagateTraceparent(
  url: string,
  tracePropagationTargets?: TracePropagationTarget[]
): boolean;

export type {
  ReactNativeSpanAttributesInput,
  ReactNativeTraceContext,
  ReactNativeTraceContextConfig,
  ReactNativeTraceInput,
  ReactNativeTraceparentConfig,
  TracePropagationTarget,
  TraceparentFetchConfig,
  TraceparentFetchLike
};
export {
  bindLogBrewTrace,
  createReactNativeSpanAttributes,
  createReactNativeTraceContext,
  createReactNativeTraceHeaders,
  createReactNativeTraceparent,
  createTraceparentFetch,
  getActiveLogBrewTrace,
  getReactNativeTraceMetadata,
  shouldPropagateTraceparent,
  withLogBrewTrace
};
