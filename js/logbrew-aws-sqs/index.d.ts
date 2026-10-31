import type { LogBrewClient, SpanLinkSummary } from "@logbrew/sdk";
import type {
  Message,
  MessageAttributeValue,
  ReceiveMessageCommandInput,
  ReceiveMessageCommandOutput,
  SQSClient,
  SendMessageBatchCommandInput,
  SendMessageBatchCommandOutput,
  SendMessageCommandInput,
  SendMessageCommandOutput
} from "@aws-sdk/client-sqs";
import type {
  QueueBatchOperationWithLogBrewSpanOptions,
  QueueOperationWithLogBrewSpanOptions
} from "@logbrew/node";

type LogBrewSqsClientLike<Output> = {
  readonly send: (command: never) => Promise<Output> | Output;
};

type LogBrewSqsCommandConstructor<Input> = new (input: Input) => unknown;

type LogBrewSqsInstrumentableClient = Pick<SQSClient, "send">;

type LogBrewSqsInstrumentationCommands = {
  readonly ReceiveMessageCommand: LogBrewSqsCommandConstructor<ReceiveMessageCommandInput>;
  readonly SendMessageBatchCommand: LogBrewSqsCommandConstructor<SendMessageBatchCommandInput>;
  readonly SendMessageCommand: LogBrewSqsCommandConstructor<SendMessageCommandInput>;
};

type LogBrewSqsInstrumentation = {
  readonly isInstalled: () => boolean;
  readonly uninstall: () => void;
};

type LogBrewSqsTraceExtractionOptions = {
  readonly extractEventBridgeEnvelopeTraceparent?: boolean;
  readonly extractSnsEnvelopeTraceparent?: boolean;
  readonly maxEnvelopeBytes?: number;
};

type LogBrewSqsOperationOptions<Result = unknown> =
  Omit<QueueOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "traceparent"> & {
    client: LogBrewClient;
    queueName?: string;
  } & LogBrewSqsTraceExtractionOptions;

type LogBrewSqsBatchOperationOptions<Result = unknown> =
  Omit<QueueBatchOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "traceparent" | "messages" | "messageCount" | "linkMetadata"> & {
    client: LogBrewClient;
    queueName?: string;
  } & LogBrewSqsTraceExtractionOptions;

type LogBrewSnsOperationOptions<Result = unknown> =
  Omit<QueueOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "traceparent"> & {
    client: LogBrewClient;
    topicName?: string;
  };

type LogBrewSnsBatchOperationOptions<Result = unknown> =
  Omit<QueueBatchOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "traceparent" | "messages" | "messageCount" | "linkMetadata"> & {
    client: LogBrewClient;
    topicName?: string;
  };

type LogBrewEventBridgeOperationOptions<Result = unknown> =
  Omit<QueueBatchOperationWithLogBrewSpanOptions<Result>, "operation" | "operationKind" | "queueName" | "system" | "traceparent" | "messages" | "messageCount" | "linkMetadata"> & {
    client: LogBrewClient;
    eventBusName?: string;
    maxEventBridgeRequestBytes?: number;
    maxRequestBytes?: number;
  };

declare function sqsSendMessageWithLogBrewSpan(
  client: LogBrewSqsClientLike<SendMessageCommandOutput>,
  SendMessageCommand: LogBrewSqsCommandConstructor<SendMessageCommandInput>,
  input: SendMessageCommandInput,
  options: LogBrewSqsOperationOptions<SendMessageCommandOutput>
): Promise<Awaited<SendMessageCommandOutput>>;

declare function sqsSendMessageBatchWithLogBrewSpan(
  client: LogBrewSqsClientLike<SendMessageBatchCommandOutput>,
  SendMessageBatchCommand: LogBrewSqsCommandConstructor<SendMessageBatchCommandInput>,
  input: SendMessageBatchCommandInput,
  options: LogBrewSqsBatchOperationOptions<SendMessageBatchCommandOutput>
): Promise<Awaited<SendMessageBatchCommandOutput>>;

declare function snsPublishWithLogBrewSpan<Input extends object, Output>(
  client: LogBrewSqsClientLike<Output>,
  PublishCommand: LogBrewSqsCommandConstructor<Input>,
  input: Input,
  options: LogBrewSnsOperationOptions<Output>
): Promise<Awaited<Output>>;

declare function snsPublishBatchWithLogBrewSpan<Input extends object, Output>(
  client: LogBrewSqsClientLike<Output>,
  PublishBatchCommand: LogBrewSqsCommandConstructor<Input>,
  input: Input,
  options: LogBrewSnsBatchOperationOptions<Output>
): Promise<Awaited<Output>>;

declare function eventBridgePutEventsWithLogBrewSpan<Input extends object, Output>(
  client: LogBrewSqsClientLike<Output>,
  PutEventsCommand: LogBrewSqsCommandConstructor<Input>,
  input: Input,
  options: LogBrewEventBridgeOperationOptions<Output>
): Promise<Awaited<Output>>;

declare function sqsReceiveMessageWithLogBrewSpan(
  client: LogBrewSqsClientLike<ReceiveMessageCommandOutput>,
  ReceiveMessageCommand: LogBrewSqsCommandConstructor<ReceiveMessageCommandInput>,
  input: ReceiveMessageCommandInput,
  options: LogBrewSqsOperationOptions<ReceiveMessageCommandOutput>
): Promise<Awaited<ReceiveMessageCommandOutput>>;

declare function withLogBrewSqsMessageProcessor<Result = unknown>(
  processor: (message: Message) => Result | Promise<Result>,
  options: LogBrewSqsOperationOptions<Result>
): (message: Message) => Promise<Awaited<Result>>;

declare function instrumentLogBrewSqsClient(
  client: LogBrewSqsInstrumentableClient,
  commands: LogBrewSqsInstrumentationCommands,
  options: LogBrewSqsOperationOptions
): LogBrewSqsInstrumentation;

declare function createLogBrewSqsSendMessageInput(
  input?: SendMessageCommandInput,
  traceparent?: string
): SendMessageCommandInput;

declare function createLogBrewSqsSendMessageBatchInput(
  input?: SendMessageBatchCommandInput,
  traceparent?: string
): SendMessageBatchCommandInput;

declare function createLogBrewSqsReceiveMessageInput(
  input?: ReceiveMessageCommandInput
): ReceiveMessageCommandInput;

declare function createLogBrewSnsPublishInput<Input extends object = Record<string, unknown>>(
  input?: Input,
  traceparent?: string
): Input & { MessageAttributes: Record<string, MessageAttributeValue> };

declare function createLogBrewSnsPublishBatchInput<Input extends object = Record<string, unknown>>(
  input?: Input,
  traceparent?: string
): Input;

declare function createLogBrewEventBridgePutEventsInput<Input extends object = Record<string, unknown>>(
  input?: Input,
  traceparent?: string,
  options?: { readonly maxEventBridgeRequestBytes?: number; readonly maxRequestBytes?: number }
): Input;

declare function createLogBrewSqsTraceLinks(
  messages?: Message | readonly Message[],
  metadata?: Readonly<Record<string, string | number | boolean | null>>,
  options?: LogBrewSqsTraceExtractionOptions
): SpanLinkSummary[];

declare function extractLogBrewSqsTraceparent(
  messageOrAttributes?: Message | SendMessageCommandInput | Readonly<Record<string, unknown>>,
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

export type {
  LogBrewEventBridgeOperationOptions,
  LogBrewSnsBatchOperationOptions,
  LogBrewSnsOperationOptions,
  LogBrewSqsBatchOperationOptions,
  LogBrewSqsClientLike,
  LogBrewSqsCommandConstructor,
  LogBrewSqsInstrumentableClient,
  LogBrewSqsInstrumentation,
  LogBrewSqsInstrumentationCommands,
  LogBrewSqsOperationOptions,
  LogBrewSqsTraceExtractionOptions
};
export {
  createLogBrewEventBridgePutEventsInput,
  createLogBrewSnsPublishBatchInput,
  createLogBrewSnsPublishInput,
  createLogBrewSqsReceiveMessageInput,
  createLogBrewSqsSendMessageBatchInput,
  createLogBrewSqsSendMessageInput,
  createLogBrewSqsTraceLinks,
  eventBridgePutEventsWithLogBrewSpan,
  extractLogBrewSqsTraceparent,
  instrumentLogBrewSqsClient,
  snsPublishBatchWithLogBrewSpan,
  snsPublishWithLogBrewSpan,
  sqsReceiveMessageWithLogBrewSpan,
  sqsSendMessageBatchWithLogBrewSpan,
  sqsSendMessageWithLogBrewSpan,
  withLogBrewSqsMessageProcessor
};
export default api;
