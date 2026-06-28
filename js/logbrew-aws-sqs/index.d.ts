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
  createLogBrewSqsReceiveMessageInput: typeof createLogBrewSqsReceiveMessageInput;
  createLogBrewSqsSendMessageBatchInput: typeof createLogBrewSqsSendMessageBatchInput;
  createLogBrewSqsSendMessageInput: typeof createLogBrewSqsSendMessageInput;
  createLogBrewSqsTraceLinks: typeof createLogBrewSqsTraceLinks;
  extractLogBrewSqsTraceparent: typeof extractLogBrewSqsTraceparent;
  instrumentLogBrewSqsClient: typeof instrumentLogBrewSqsClient;
  sqsReceiveMessageWithLogBrewSpan: typeof sqsReceiveMessageWithLogBrewSpan;
  sqsSendMessageBatchWithLogBrewSpan: typeof sqsSendMessageBatchWithLogBrewSpan;
  sqsSendMessageWithLogBrewSpan: typeof sqsSendMessageWithLogBrewSpan;
  withLogBrewSqsMessageProcessor: typeof withLogBrewSqsMessageProcessor;
};

export default api;
