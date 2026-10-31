import type { LogBrewClient, SpanEventSummary, SpanLinkSummary } from "@logbrew/sdk";
import type {
  LogBrewInstrumentationHandle,
  LogBrewSpanCaptureErrorContext,
  LogBrewSpanCaptureErrorHandler,
  LogBrewSpanMetadata
} from "./span-types.js";
import type { LogBrewTraceContext } from "./index.js";

type LogBrewMethod = (...args: readonly unknown[]) => unknown;

type LogBrewOperationSpanOptions<Result> = {
  client: LogBrewClient;
  operation: () => Result | Promise<Result>;
  system?: string;
  operationKind?: string;
  trace?: LogBrewTraceContext;
  id?: string;
  events?: SpanEventSummary[];
  links?: SpanLinkSummary[];
  metadata?: LogBrewSpanMetadata;
  now?: () => string;
  nowMs?: () => number;
  spanIdFactory?: () => string;
  traceIdFactory?: () => string;
  onCaptureError?: LogBrewSpanCaptureErrorHandler<LogBrewSpanCaptureErrorContext>;
};

type LogBrewClientInstrumentationOptions = {
  client: LogBrewClient;
  trace?: LogBrewTraceContext;
  id?: string;
  metadata?: LogBrewSpanMetadata;
  now?: () => string;
  nowMs?: () => number;
  spanIdFactory?: () => string;
  traceIdFactory?: () => string;
  onCaptureError?: LogBrewSpanCaptureErrorHandler<LogBrewSpanCaptureErrorContext>;
};

type DatabaseOperationWithLogBrewSpanOptions<Result = unknown> = LogBrewOperationSpanOptions<Result> & {
  databaseName?: string;
  statementTemplate?: string;
  rowCount?: number;
};

type CacheOperationWithLogBrewSpanOptions<Result = unknown> = LogBrewOperationSpanOptions<Result> & {
  cacheName?: string;
  hit?: boolean;
  itemSizeBytes?: number;
  itemCount?: number;
};

type LogBrewPgQueryable = {
  query: LogBrewMethod;
};

type LogBrewPgInstrumentation = LogBrewInstrumentationHandle;

type LogBrewPgClientInstrumentationOptions = LogBrewClientInstrumentationOptions & {
  databaseName?: string;
  operationKind?: string;
  operationName?: string;
};

type LogBrewRedisCommand =
  | string
  | (string | number | Buffer)[]
  | {
      name?: string;
      args?: unknown[];
      [key: string]: unknown;
    };

type LogBrewRedisPipeline = {
  addCommand?: (command: LogBrewRedisCommand, ...args: readonly unknown[]) => unknown;
  exec?: LogBrewMethod;
  execAsPipeline?: LogBrewMethod;
  [commandName: string]: unknown;
};

type LogBrewRedisCommandClient = {
  sendCommand: (command: LogBrewRedisCommand, ...args: readonly unknown[]) => unknown;
  connect?: LogBrewMethod;
  multi?: (...args: readonly unknown[]) => LogBrewRedisPipeline;
  MULTI?: (...args: readonly unknown[]) => LogBrewRedisPipeline;
  pipeline?: (...args: readonly unknown[]) => LogBrewRedisPipeline;
};

type LogBrewRedisClientInstrumentation = LogBrewInstrumentationHandle;

type LogBrewRedisClientInstrumentationOptions = LogBrewClientInstrumentationOptions & {
  cacheName?: string;
  operationKind?: string;
  operationName?: string;
  tracePipelines?: boolean;
};

type LogBrewMongoCursor = {
  forEach?: LogBrewMethod;
  hasNext?: LogBrewMethod;
  next?: LogBrewMethod;
  toArray?: LogBrewMethod;
  tryNext?: LogBrewMethod;
  [key: string]: unknown;
};

type LogBrewMongoCollection = {
  collectionName?: string;
  dbName?: string;
  namespace?: string | {
    db?: string;
    collection?: string;
  };
  aggregate?: LogBrewMethod;
  bulkWrite?: LogBrewMethod;
  count?: LogBrewMethod;
  countDocuments?: LogBrewMethod;
  deleteMany?: LogBrewMethod;
  deleteOne?: LogBrewMethod;
  distinct?: LogBrewMethod;
  estimatedDocumentCount?: LogBrewMethod;
  find?: LogBrewMethod;
  findOne?: LogBrewMethod;
  insertMany?: LogBrewMethod;
  insertOne?: LogBrewMethod;
  replaceOne?: LogBrewMethod;
  updateMany?: LogBrewMethod;
  updateOne?: LogBrewMethod;
  [key: string]: unknown;
};

type LogBrewMongoCollectionInstrumentation = LogBrewInstrumentationHandle;

type LogBrewMongoCollectionInstrumentationOptions = LogBrewClientInstrumentationOptions & {
  databaseName?: string;
  collectionName?: string;
  operationKind?: string;
};

type LogBrewMongooseExecutable = {
  exec?: LogBrewMethod;
  [key: string]: unknown;
};

type LogBrewMongooseDocumentPrototype = {
  save?: LogBrewMethod;
  $save?: LogBrewMethod;
  updateOne?: LogBrewMethod;
  deleteOne?: LogBrewMethod;
  [key: string]: unknown;
};

type LogBrewMongooseModel = {
  modelName?: string;
  collection?: {
    collectionName?: string;
    name?: string;
    [key: string]: unknown;
  };
  prototype?: LogBrewMongooseDocumentPrototype;
  aggregate?: LogBrewMethod;
  bulkWrite?: LogBrewMethod;
  count?: LogBrewMethod;
  countDocuments?: LogBrewMethod;
  create?: LogBrewMethod;
  deleteMany?: LogBrewMethod;
  deleteOne?: LogBrewMethod;
  distinct?: LogBrewMethod;
  estimatedDocumentCount?: LogBrewMethod;
  find?: LogBrewMethod;
  findById?: LogBrewMethod;
  findByIdAndDelete?: LogBrewMethod;
  findByIdAndRemove?: LogBrewMethod;
  findByIdAndUpdate?: LogBrewMethod;
  findOne?: LogBrewMethod;
  findOneAndDelete?: LogBrewMethod;
  findOneAndRemove?: LogBrewMethod;
  findOneAndReplace?: LogBrewMethod;
  findOneAndUpdate?: LogBrewMethod;
  insertMany?: LogBrewMethod;
  replaceOne?: LogBrewMethod;
  updateMany?: LogBrewMethod;
  updateOne?: LogBrewMethod;
  where?: LogBrewMethod;
  [key: string]: unknown;
};

type LogBrewMongooseModelInstrumentation = LogBrewInstrumentationHandle;

type LogBrewMongooseModelInstrumentationOptions = LogBrewClientInstrumentationOptions & {
  databaseName?: string;
  collectionName?: string;
  modelName?: string;
};

declare function databaseOperationWithLogBrewSpan<Result>(
  operationName: string,
  options: DatabaseOperationWithLogBrewSpanOptions<Result>
): Promise<Awaited<Result>>;

declare function cacheOperationWithLogBrewSpan<Result>(
  operationName: string,
  options: CacheOperationWithLogBrewSpanOptions<Result>
): Promise<Awaited<Result>>;

declare function instrumentLogBrewPgClient(
  pgClient: LogBrewPgQueryable,
  options: LogBrewPgClientInstrumentationOptions
): LogBrewPgInstrumentation;

declare function instrumentLogBrewRedisClient(
  redisClient: LogBrewRedisCommandClient,
  options: LogBrewRedisClientInstrumentationOptions
): LogBrewRedisClientInstrumentation;

declare function instrumentLogBrewMongoCollection(
  mongoCollection: LogBrewMongoCollection,
  options: LogBrewMongoCollectionInstrumentationOptions
): LogBrewMongoCollectionInstrumentation;

declare function instrumentLogBrewMongooseModel(
  mongooseModel: LogBrewMongooseModel,
  options: LogBrewMongooseModelInstrumentationOptions
): LogBrewMongooseModelInstrumentation;

export type {
  CacheOperationWithLogBrewSpanOptions,
  DatabaseOperationWithLogBrewSpanOptions,
  LogBrewClientInstrumentationOptions,
  LogBrewMethod,
  LogBrewMongoCollection,
  LogBrewMongoCollectionInstrumentation,
  LogBrewMongoCollectionInstrumentationOptions,
  LogBrewMongoCursor,
  LogBrewMongooseDocumentPrototype,
  LogBrewMongooseExecutable,
  LogBrewMongooseModel,
  LogBrewMongooseModelInstrumentation,
  LogBrewMongooseModelInstrumentationOptions,
  LogBrewOperationSpanOptions,
  LogBrewPgClientInstrumentationOptions,
  LogBrewPgInstrumentation,
  LogBrewPgQueryable,
  LogBrewRedisClientInstrumentation,
  LogBrewRedisClientInstrumentationOptions,
  LogBrewRedisCommand,
  LogBrewRedisCommandClient,
  LogBrewRedisPipeline
};
export {
  cacheOperationWithLogBrewSpan,
  databaseOperationWithLogBrewSpan,
  instrumentLogBrewMongoCollection,
  instrumentLogBrewMongooseModel,
  instrumentLogBrewPgClient,
  instrumentLogBrewRedisClient
};
