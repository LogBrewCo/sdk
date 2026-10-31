import type {
  Consumer,
  EachBatchPayload,
  EachMessagePayload,
  Producer,
  ProducerBatch,
  ProducerRecord,
  RecordMetadata
} from "kafkajs";
import type { QueueBatchOperationWithLogBrewSpanOptions, QueueOperationWithLogBrewSpanOptions } from "@logbrew/node";
import type { LogBrewClient } from "@logbrew/sdk";

type LogBrewKafkaJsHeaderValue = Buffer | string | (Buffer | string)[] | undefined;
type LogBrewKafkaJsHeaders = Record<string, LogBrewKafkaJsHeaderValue>;
type ReadonlyHeaders = Readonly<Record<string, Buffer | string | readonly (Buffer | string)[] | undefined>>;
type DeepReadonly<Value> = Value extends Buffer
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;
type LogBrewKafkaJsMessageLike = {
  headers?: LogBrewKafkaJsHeaders;
  [key: string]: unknown;
};

type LogBrewKafkaJsSendOptions<Result = RecordMetadata[]> =
  Omit<QueueBatchOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "messageCount"> & {
    topicName?: string;
    client: LogBrewClient;
  };

type LogBrewKafkaJsProcessOptions<Result = unknown> =
  Omit<QueueOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "traceparent"> & {
    topicName?: string;
    client: LogBrewClient;
  };

type LogBrewKafkaJsBatchProcessOptions<Result = unknown> =
  Omit<QueueBatchOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "messages" | "linkMetadata"> & {
    topicName?: string;
    client: LogBrewClient;
  };

type LogBrewKafkaJsInstrumentationOptions<Result = unknown> =
  Omit<
    QueueBatchOperationWithLogBrewSpanOptions<Result>,
    "operation" | "operationKind" | "queueName" | "system" | "traceparent" | "messageCount" | "messages" | "linkMetadata"
  > & {
    topicName?: string;
    client: LogBrewClient;
  };

type LogBrewKafkaJsInstrumentation = {
  uninstall: () => void;
};

declare function kafkaJsProducerSendWithLogBrewSpan(
  producer: Readonly<Pick<Producer, "send">>,
  record: ProducerRecord,
  options: LogBrewKafkaJsSendOptions
): Promise<RecordMetadata[]>;

declare function kafkaJsProducerSendBatchWithLogBrewSpan(
  producer: Readonly<Pick<Producer, "sendBatch">>,
  batch: ProducerBatch,
  options: LogBrewKafkaJsSendOptions
): Promise<RecordMetadata[]>;

declare function withLogBrewKafkaJsEachMessage<Result = void>(
  eachMessage: (payload: EachMessagePayload) => Result | Promise<Result>,
  options: LogBrewKafkaJsProcessOptions<Result>
): (payload: EachMessagePayload) => Promise<Awaited<Result>>;

declare function withLogBrewKafkaJsEachBatch<Result = void>(
  eachBatch: (payload: EachBatchPayload) => Result | Promise<Result>,
  options: LogBrewKafkaJsBatchProcessOptions<Result>
): (payload: EachBatchPayload) => Promise<Awaited<Result>>;

declare function instrumentLogBrewKafkaJsProducer(
  producer: Readonly<Partial<Pick<Producer, "send" | "sendBatch">>> & object,
  options: LogBrewKafkaJsSendOptions
): LogBrewKafkaJsInstrumentation;

declare function instrumentLogBrewKafkaJsConsumer(
  consumer: Readonly<Pick<Consumer, "run">>,
  options: LogBrewKafkaJsInstrumentationOptions
): LogBrewKafkaJsInstrumentation;

declare function createLogBrewKafkaJsProducerRecord(
  record?: DeepReadonly<Partial<ProducerRecord>>,
  traceparent?: string
): Partial<ProducerRecord>;

declare function createLogBrewKafkaJsProducerBatch(
  batch?: DeepReadonly<Partial<ProducerBatch>>,
  traceparent?: string
): Partial<ProducerBatch>;

declare function createLogBrewKafkaJsMessage<TMessage extends LogBrewKafkaJsMessageLike>(
  message?: TMessage,
  traceparent?: string
): TMessage & { headers?: LogBrewKafkaJsHeaders };

declare function extractLogBrewKafkaJsTraceparent(message?: { readonly headers?: ReadonlyHeaders }): string | undefined;

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

export type {
  LogBrewKafkaJsBatchProcessOptions,
  LogBrewKafkaJsHeaders,
  LogBrewKafkaJsHeaderValue,
  LogBrewKafkaJsInstrumentation,
  LogBrewKafkaJsInstrumentationOptions,
  LogBrewKafkaJsMessageLike,
  LogBrewKafkaJsProcessOptions,
  LogBrewKafkaJsSendOptions
};
export {
  createLogBrewKafkaJsMessage,
  createLogBrewKafkaJsProducerBatch,
  createLogBrewKafkaJsProducerRecord,
  extractLogBrewKafkaJsTraceparent,
  instrumentLogBrewKafkaJsConsumer,
  instrumentLogBrewKafkaJsProducer,
  kafkaJsProducerSendBatchWithLogBrewSpan,
  kafkaJsProducerSendWithLogBrewSpan,
  withLogBrewKafkaJsEachBatch,
  withLogBrewKafkaJsEachMessage
};
export default api;
