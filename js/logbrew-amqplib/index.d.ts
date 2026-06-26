import type { Channel, ConsumeMessage, Options } from "amqplib";
import type { LogBrewClient } from "@logbrew/sdk";
import type { QueueOperationWithLogBrewSpanOptions } from "@logbrew/node";

export type LogBrewAmqplibHeaders = Record<string, unknown>;
export type LogBrewAmqplibMessageLike = {
  fields?: {
    exchange?: string;
    routingKey?: string;
  };
  properties?: {
    headers?: LogBrewAmqplibHeaders;
  };
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
  channel: Pick<Channel, "publish">,
  exchange: string,
  routingKey: string,
  content: Buffer,
  publishOptions: Options.Publish | undefined,
  options: LogBrewAmqplibPublishOptions<Result>
): Promise<Awaited<Result>>;

export declare function amqplibSendToQueueWithLogBrewSpan<Result = boolean>(
  channel: Pick<Channel, "sendToQueue">,
  queue: string,
  content: Buffer,
  publishOptions: Options.Publish | undefined,
  options: LogBrewAmqplibPublishOptions<Result>
): Promise<Awaited<Result>>;

export declare function withLogBrewAmqplibConsumer<Result = unknown>(
  onMessage: (message: ConsumeMessage | null) => Result | Promise<Result>,
  options: LogBrewAmqplibConsumeOptions<Result>
): (message: ConsumeMessage | null) => Promise<Awaited<Result>>;

export declare function createLogBrewAmqplibPublishOptions(
  publishOptions?: Options.Publish,
  traceparent?: string
): Options.Publish;

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
