import type {
  Message,
  MessageAttributeValue,
  ReceiveMessageCommandInput,
  ReceiveMessageCommandOutput,
  SendMessageBatchCommandInput,
  SendMessageBatchCommandOutput,
  SendMessageCommandInput,
  SendMessageCommandOutput,
  SQSClient
} from "@aws-sdk/client-sqs";
import type { LogBrewClient, SpanLinkSummary } from "@logbrew/sdk";
import type {
  QueueBatchOperationWithLogBrewSpanOptions,
  QueueOperationWithLogBrewSpanOptions
} from "@logbrew/node";

export type LogBrewSqsClientLike<Output> = {
  send(command: unknown): Promise<Output> | Output;
};

export type LogBrewSqsCommandConstructor<Input> = new (input: Input) => unknown;

export type LogBrewSqsInstrumentableClient = Pick<SQSClient, "send">;

export type LogBrewSqsInstrumentationCommands = {
  ReceiveMessageCommand: LogBrewSqsCommandConstructor<ReceiveMessageCommandInput>;
  SendMessageBatchCommand: LogBrewSqsCommandConstructor<SendMessageBatchCommandInput>;
  SendMessageCommand: LogBrewSqsCommandConstructor<SendMessageCommandInput>;
};

export type LogBrewSqsInstrumentation = {
  isInstalled(): boolean;
  uninstall(): void;
};

export type LogBrewSqsTraceExtractionOptions = {
  extractEventBridgeEnvelopeTraceparent?: boolean;
  extractSnsEnvelopeTraceparent?: boolean;
  maxEnvelopeBytes?: number;
};

export type LogBrewSqsOperationOptions<Result = unknown> =
  Omit<QueueOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "traceparent"> & {
    client: LogBrewClient;
    queueName?: string;
  } & LogBrewSqsTraceExtractionOptions;

export type LogBrewSqsBatchOperationOptions<Result = unknown> =
  Omit<QueueBatchOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "traceparent" | "messages" | "messageCount" | "linkMetadata"> & {
    client: LogBrewClient;
    queueName?: string;
  } & LogBrewSqsTraceExtractionOptions;

export type LogBrewSnsOperationOptions<Result = unknown> =
  Omit<QueueOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "traceparent"> & {
    client: LogBrewClient;
    topicName?: string;
  };

export type LogBrewSnsBatchOperationOptions<Result = unknown> =
  Omit<QueueBatchOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "traceparent" | "messages" | "messageCount" | "linkMetadata"> & {
    client: LogBrewClient;
    topicName?: string;
  };

export type LogBrewEventBridgeOperationOptions<Result = unknown> =
  Omit<QueueBatchOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "traceparent" | "messages" | "messageCount" | "linkMetadata"> & {
    client: LogBrewClient;
    eventBusName?: string;
    maxEventBridgeRequestBytes?: number;
    maxRequestBytes?: number;
  };

export declare function sqsSendMessageWithLogBrewSpan(
  client: LogBrewSqsClientLike<SendMessageCommandOutput>,
  SendMessageCommand: LogBrewSqsCommandConstructor<SendMessageCommandInput>,
  input: SendMessageCommandInput,
  options: LogBrewSqsOperationOptions<SendMessageCommandOutput>
): Promise<Awaited<SendMessageCommandOutput>>;

export declare function sqsSendMessageBatchWithLogBrewSpan(
  client: LogBrewSqsClientLike<SendMessageBatchCommandOutput>,
  SendMessageBatchCommand: LogBrewSqsCommandConstructor<SendMessageBatchCommandInput>,
  input: SendMessageBatchCommandInput,
  options: LogBrewSqsBatchOperationOptions<SendMessageBatchCommandOutput>
): Promise<Awaited<SendMessageBatchCommandOutput>>;

export declare function snsPublishWithLogBrewSpan<Input extends object, Output>(
  client: LogBrewSqsClientLike<Output>,
  PublishCommand: LogBrewSqsCommandConstructor<Input>,
  input: Input,
  options: LogBrewSnsOperationOptions<Output>
): Promise<Awaited<Output>>;

export declare function snsPublishBatchWithLogBrewSpan<Input extends object, Output>(
  client: LogBrewSqsClientLike<Output>,
  PublishBatchCommand: LogBrewSqsCommandConstructor<Input>,
  input: Input,
  options: LogBrewSnsBatchOperationOptions<Output>
): Promise<Awaited<Output>>;

export declare function eventBridgePutEventsWithLogBrewSpan<Input extends object, Output>(
  client: LogBrewSqsClientLike<Output>,
  PutEventsCommand: LogBrewSqsCommandConstructor<Input>,
  input: Input,
  options: LogBrewEventBridgeOperationOptions<Output>
): Promise<Awaited<Output>>;

export declare function sqsReceiveMessageWithLogBrewSpan(
  client: LogBrewSqsClientLike<ReceiveMessageCommandOutput>,
  ReceiveMessageCommand: LogBrewSqsCommandConstructor<ReceiveMessageCommandInput>,
  input: ReceiveMessageCommandInput,
  options: LogBrewSqsOperationOptions<ReceiveMessageCommandOutput>
): Promise<Awaited<ReceiveMessageCommandOutput>>;

export declare function withLogBrewSqsMessageProcessor<Result = unknown>(
  processor: (message: Message) => Result | Promise<Result>,
  options: LogBrewSqsOperationOptions<Result>
): (message: Message) => Promise<Awaited<Result>>;

export declare function instrumentLogBrewSqsClient(
  client: LogBrewSqsInstrumentableClient,
  commands: LogBrewSqsInstrumentationCommands,
  options: LogBrewSqsOperationOptions<unknown>
): LogBrewSqsInstrumentation;

export declare function createLogBrewSqsSendMessageInput(
  input?: SendMessageCommandInput,
  traceparent?: string
): SendMessageCommandInput;

export declare function createLogBrewSqsSendMessageBatchInput(
  input?: SendMessageBatchCommandInput,
  traceparent?: string
): SendMessageBatchCommandInput;

export declare function createLogBrewSqsReceiveMessageInput(
  input?: ReceiveMessageCommandInput
): ReceiveMessageCommandInput;

export declare function createLogBrewSnsPublishInput<Input extends object = Record<string, unknown>>(
  input?: Input,
  traceparent?: string
): Input & { MessageAttributes: Record<string, MessageAttributeValue> };

export declare function createLogBrewSnsPublishBatchInput<Input extends object = Record<string, unknown>>(
  input?: Input,
  traceparent?: string
): Input;

export declare function createLogBrewEventBridgePutEventsInput<Input extends object = Record<string, unknown>>(
  input?: Input,
  traceparent?: string,
  options?: { maxEventBridgeRequestBytes?: number; maxRequestBytes?: number }
): Input;

export declare function createLogBrewSqsTraceLinks(
  messages?: Message | Message[],
  metadata?: Record<string, string | number | boolean | null>,
  options?: LogBrewSqsTraceExtractionOptions
): SpanLinkSummary[];

export declare function extractLogBrewSqsTraceparent(
  messageOrAttributes?: Message | SendMessageCommandInput | Record<string, MessageAttributeValue | string | unknown>,
  options?: LogBrewSqsTraceExtractionOptions
): string | undefined;

declare const api: {
  createLogBrewEventBridgePutEventsInput: typeof createLogBrewEventBridgePutEventsInput;
  createLogBrewSnsPublishBatchInput: typeof createLogBrewSnsPublishBatchInput;
  createLogBrewSnsPublishInput: typeof createLogBrewSnsPublishInput;
  createLogBrewSqsReceiveMessageInput: typeof createLogBrewSqsReceiveMessageInput;
  createLogBrewSqsSendMessageBatchInput: typeof createLogBrewSqsSendMessageBatchInput;
  createLogBrewSqsSendMessageInput: typeof createLogBrewSqsSendMessageInput;
  createLogBrewSqsTraceLinks: typeof createLogBrewSqsTraceLinks;
  eventBridgePutEventsWithLogBrewSpan: typeof eventBridgePutEventsWithLogBrewSpan;
  extractLogBrewSqsTraceparent: typeof extractLogBrewSqsTraceparent;
  instrumentLogBrewSqsClient: typeof instrumentLogBrewSqsClient;
  snsPublishBatchWithLogBrewSpan: typeof snsPublishBatchWithLogBrewSpan;
  snsPublishWithLogBrewSpan: typeof snsPublishWithLogBrewSpan;
  sqsReceiveMessageWithLogBrewSpan: typeof sqsReceiveMessageWithLogBrewSpan;
  sqsSendMessageBatchWithLogBrewSpan: typeof sqsSendMessageBatchWithLogBrewSpan;
  sqsSendMessageWithLogBrewSpan: typeof sqsSendMessageWithLogBrewSpan;
  withLogBrewSqsMessageProcessor: typeof withLogBrewSqsMessageProcessor;
};

export default api;
