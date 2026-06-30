import type { LogBrewClient } from "@logbrew/sdk";
import type { QueueOperationWithLogBrewSpanOptions } from "@logbrew/node";

export type LogBrewAmqplibHeaders = Record<string, unknown>;
export type LogBrewAmqplibPublishOptionsLike = {
  headers?: LogBrewAmqplibHeaders;
  [key: string]: unknown;
};
export type LogBrewAmqplibChannel = {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options?: LogBrewAmqplibPublishOptionsLike
  ): boolean | Promise<boolean>;
  sendToQueue(
    queue: string,
    content: Buffer,
    options?: LogBrewAmqplibPublishOptionsLike
  ): boolean | Promise<boolean>;
};
export type LogBrewAmqplibMessageLike = {
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

export type LogBrewAmqplibPublishOptions<Result = boolean> =
  Omit<QueueOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "traceparent"> & {
    client: LogBrewClient;
    destinationName?: string;
  };

export type LogBrewAmqplibConsumeOptions<Result = unknown> =
  Omit<QueueOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "traceparent"> & {
    client: LogBrewClient;
    queueName?: string;
  };

export declare function amqplibPublishWithLogBrewSpan<Result = boolean>(
  channel: Pick<LogBrewAmqplibChannel, "publish">,
  exchange: string,
  routingKey: string,
  content: Buffer,
  publishOptions: LogBrewAmqplibPublishOptionsLike | undefined,
  options: LogBrewAmqplibPublishOptions<Result>
): Promise<Awaited<Result>>;

export declare function amqplibSendToQueueWithLogBrewSpan<Result = boolean>(
  channel: Pick<LogBrewAmqplibChannel, "sendToQueue">,
  queue: string,
  content: Buffer,
  publishOptions: LogBrewAmqplibPublishOptionsLike | undefined,
  options: LogBrewAmqplibPublishOptions<Result>
): Promise<Awaited<Result>>;

export declare function withLogBrewAmqplibConsumer<Result = unknown>(
  onMessage: (message: LogBrewAmqplibMessageLike | null) => Result | Promise<Result>,
  options: LogBrewAmqplibConsumeOptions<Result>
): (message: LogBrewAmqplibMessageLike | null) => Promise<Awaited<Result>>;

export declare function createLogBrewAmqplibPublishOptions(
  publishOptions?: LogBrewAmqplibPublishOptionsLike,
  traceparent?: string
): LogBrewAmqplibPublishOptionsLike;

export declare function extractLogBrewAmqplibTraceparent(
  messageOrHeaders?: LogBrewAmqplibMessageLike | LogBrewAmqplibHeaders
): string | undefined;

declare const api: {
  amqplibPublishWithLogBrewSpan: typeof amqplibPublishWithLogBrewSpan;
  amqplibSendToQueueWithLogBrewSpan: typeof amqplibSendToQueueWithLogBrewSpan;
  createLogBrewAmqplibPublishOptions: typeof createLogBrewAmqplibPublishOptions;
  extractLogBrewAmqplibTraceparent: typeof extractLogBrewAmqplibTraceparent;
  withLogBrewAmqplibConsumer: typeof withLogBrewAmqplibConsumer;
};

export default api;
