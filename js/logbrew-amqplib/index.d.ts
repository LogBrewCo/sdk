import type { LogBrewClient } from "@logbrew/sdk";
import type { QueueOperationWithLogBrewSpanOptions } from "@logbrew/node";

type LogBrewAmqplibHeaders = Record<string, unknown>;
type LogBrewAmqplibPublishOptionsLike = {
  headers?: LogBrewAmqplibHeaders;
  [key: string]: unknown;
};
type ReadonlyPublishOptionsLike = {
  readonly headers?: Readonly<LogBrewAmqplibHeaders>;
  readonly [key: string]: unknown;
};
type LogBrewAmqplibChannel = {
  publish: (
    exchange: string,
    routingKey: string,
    content: Buffer,
    options?: ReadonlyPublishOptionsLike
  ) => boolean | Promise<boolean>;
  sendToQueue: (
    queue: string,
    content: Buffer,
    options?: ReadonlyPublishOptionsLike
  ) => boolean | Promise<boolean>;
};
type LogBrewAmqplibMessageLike = {
  fields?: {
    exchange?: string;
    routingKey?: string;
    [key: string]: unknown;
  };
  properties?: {
    headers?: LogBrewAmqplibHeaders;
    [key: string]: unknown;
  };
  content?: Buffer;
  [key: string]: unknown;
};
type MessageShape = {
  readonly fields?: {
    readonly exchange?: string;
    readonly routingKey?: string;
  };
  readonly properties?: {
    readonly headers?: Readonly<LogBrewAmqplibHeaders> | undefined;
  };
  readonly content?: Buffer;
};

type LogBrewAmqplibPublishOptions<Result = boolean> =
  Omit<QueueOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "traceparent"> & {
    client: LogBrewClient;
    destinationName?: string;
  };

type LogBrewAmqplibConsumeOptions<Result = unknown> =
  Omit<QueueOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "traceparent"> & {
    client: LogBrewClient;
    queueName?: string;
  };

declare function amqplibPublishWithLogBrewSpan<Result = boolean>(
  channel: Readonly<Pick<LogBrewAmqplibChannel, "publish">>,
  exchange: string,
  routingKey: string,
  content: Buffer,
  publishOptions: ReadonlyPublishOptionsLike | undefined,
  options: LogBrewAmqplibPublishOptions<Result>
): Promise<Awaited<Result>>;

declare function amqplibSendToQueueWithLogBrewSpan<Result = boolean>(
  channel: Readonly<Pick<LogBrewAmqplibChannel, "sendToQueue">>,
  queue: string,
  content: Buffer,
  publishOptions: ReadonlyPublishOptionsLike | undefined,
  options: LogBrewAmqplibPublishOptions<Result>
): Promise<Awaited<Result>>;

declare function withLogBrewAmqplibConsumer<
  Result = unknown,
  Message extends MessageShape = LogBrewAmqplibMessageLike
>(
  onMessage: (message: Message | null) => Result | Promise<Result>,
  options: LogBrewAmqplibConsumeOptions<Result>
): (message: Message | null) => Promise<Awaited<Result>>;

declare function createLogBrewAmqplibPublishOptions(
  publishOptions?: ReadonlyPublishOptionsLike,
  traceparent?: string
): LogBrewAmqplibPublishOptionsLike;

declare function extractLogBrewAmqplibTraceparent(
  messageOrHeaders?: MessageShape | Readonly<LogBrewAmqplibHeaders>
): string | undefined;

declare const api: {
  amqplibPublishWithLogBrewSpan: typeof amqplibPublishWithLogBrewSpan;
  amqplibSendToQueueWithLogBrewSpan: typeof amqplibSendToQueueWithLogBrewSpan;
  createLogBrewAmqplibPublishOptions: typeof createLogBrewAmqplibPublishOptions;
  extractLogBrewAmqplibTraceparent: typeof extractLogBrewAmqplibTraceparent;
  withLogBrewAmqplibConsumer: typeof withLogBrewAmqplibConsumer;
};

export type {
  LogBrewAmqplibChannel,
  LogBrewAmqplibConsumeOptions,
  LogBrewAmqplibHeaders,
  LogBrewAmqplibMessageLike,
  LogBrewAmqplibPublishOptions,
  LogBrewAmqplibPublishOptionsLike
};
export {
  amqplibPublishWithLogBrewSpan,
  amqplibSendToQueueWithLogBrewSpan,
  createLogBrewAmqplibPublishOptions,
  extractLogBrewAmqplibTraceparent,
  withLogBrewAmqplibConsumer
};
export default api;
