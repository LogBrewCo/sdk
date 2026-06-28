import type {
  Consumer,
  EachBatchPayload,
  EachMessagePayload,
  Producer,
  ProducerBatch,
  ProducerRecord,
  RecordMetadata
} from "kafkajs";
import type { LogBrewClient } from "@logbrew/sdk";
import type { QueueBatchOperationWithLogBrewSpanOptions, QueueOperationWithLogBrewSpanOptions } from "@logbrew/node";

export type LogBrewKafkaJsHeaderValue = Buffer | string | Array<Buffer | string> | undefined;
export type LogBrewKafkaJsHeaders = Record<string, LogBrewKafkaJsHeaderValue>;
export type LogBrewKafkaJsMessageLike = {
  headers?: LogBrewKafkaJsHeaders;
  [key: string]: unknown;
};

export type LogBrewKafkaJsSendOptions<Result = RecordMetadata[]> =
  Omit<QueueBatchOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "messageCount"> & {
    topicName?: string;
    client: LogBrewClient;
  };

export type LogBrewKafkaJsProcessOptions<Result = unknown> =
  Omit<QueueOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "traceparent"> & {
    topicName?: string;
    client: LogBrewClient;
  };

export type LogBrewKafkaJsBatchProcessOptions<Result = unknown> =
  Omit<QueueBatchOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "messages" | "linkMetadata"> & {
    topicName?: string;
    client: LogBrewClient;
  };

export type LogBrewKafkaJsInstrumentationOptions<Result = unknown> =
  Omit<
    QueueBatchOperationWithLogBrewSpanOptions<Result>,
    "operation" | "operationKind" | "queueName" | "system" | "traceparent" | "messageCount" | "messages" | "linkMetadata"
  > & {
    topicName?: string;
    client: LogBrewClient;
  };

export type LogBrewKafkaJsInstrumentation = {
  uninstall(): void;
};

export declare function kafkaJsProducerSendWithLogBrewSpan(
  producer: Pick<Producer, "send">,
  record: ProducerRecord,
  options: LogBrewKafkaJsSendOptions
): Promise<RecordMetadata[]>;

export declare function kafkaJsProducerSendBatchWithLogBrewSpan(
  producer: Pick<Producer, "sendBatch">,
  batch: ProducerBatch,
  options: LogBrewKafkaJsSendOptions
): Promise<RecordMetadata[]>;

export declare function withLogBrewKafkaJsEachMessage<Result = void>(
  eachMessage: (payload: EachMessagePayload) => Result | Promise<Result>,
  options: LogBrewKafkaJsProcessOptions<Result>
): (payload: EachMessagePayload) => Promise<Awaited<Result>>;

export declare function withLogBrewKafkaJsEachBatch<Result = void>(
  eachBatch: (payload: EachBatchPayload) => Result | Promise<Result>,
  options: LogBrewKafkaJsBatchProcessOptions<Result>
): (payload: EachBatchPayload) => Promise<Awaited<Result>>;

export declare function instrumentLogBrewKafkaJsProducer(
  producer: Partial<Pick<Producer, "send" | "sendBatch">> & object,
  options: LogBrewKafkaJsSendOptions
): LogBrewKafkaJsInstrumentation;

export declare function instrumentLogBrewKafkaJsConsumer(
  consumer: Pick<Consumer, "run">,
  options: LogBrewKafkaJsInstrumentationOptions
): LogBrewKafkaJsInstrumentation;

export declare function createLogBrewKafkaJsProducerRecord(
  record?: Partial<ProducerRecord>,
  traceparent?: string
): Partial<ProducerRecord>;

export declare function createLogBrewKafkaJsProducerBatch(
  batch?: Partial<ProducerBatch>,
  traceparent?: string
): Partial<ProducerBatch>;

export declare function createLogBrewKafkaJsMessage<TMessage extends LogBrewKafkaJsMessageLike>(
  message?: TMessage,
  traceparent?: string
): TMessage & { headers?: LogBrewKafkaJsHeaders };

export declare function extractLogBrewKafkaJsTraceparent(message?: { headers?: LogBrewKafkaJsHeaders }): string | undefined;

declare const api: {
  createLogBrewKafkaJsMessage: typeof createLogBrewKafkaJsMessage;
  createLogBrewKafkaJsProducerBatch: typeof createLogBrewKafkaJsProducerBatch;
  createLogBrewKafkaJsProducerRecord: typeof createLogBrewKafkaJsProducerRecord;
  extractLogBrewKafkaJsTraceparent: typeof extractLogBrewKafkaJsTraceparent;
  instrumentLogBrewKafkaJsConsumer: typeof instrumentLogBrewKafkaJsConsumer;
  instrumentLogBrewKafkaJsProducer: typeof instrumentLogBrewKafkaJsProducer;
  kafkaJsProducerSendBatchWithLogBrewSpan: typeof kafkaJsProducerSendBatchWithLogBrewSpan;
  kafkaJsProducerSendWithLogBrewSpan: typeof kafkaJsProducerSendWithLogBrewSpan;
  withLogBrewKafkaJsEachBatch: typeof withLogBrewKafkaJsEachBatch;
  withLogBrewKafkaJsEachMessage: typeof withLogBrewKafkaJsEachMessage;
};

export default api;
