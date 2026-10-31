import type { DatabaseOperationWithLogBrewSpanOptions, LogBrewTraceContext } from "@logbrew/node";
import type { LogBrewClient, SpanEventSummary, SpanLinkSummary } from "@logbrew/sdk";

type LogBrewPrismaPrimitiveMetadata = Record<string, string | number | boolean | null>;

type LogBrewPrismaOperationContext<Result = unknown> = {
  readonly args?: unknown;
  readonly model?: string;
  readonly operation?: string;
  readonly query: (args?: unknown) => Result | Promise<Result>;
};

type LogBrewPrismaSpanOptions = {
  client: LogBrewClient;
  databaseName?: string;
  trace?: LogBrewTraceContext;
  id?: string;
  events?: SpanEventSummary[];
  links?: SpanLinkSummary[];
  metadata?: LogBrewPrismaPrimitiveMetadata;
  now?: () => string;
  nowMs?: () => number;
  spanIdFactory?: () => string;
  traceIdFactory?: () => string;
  onCaptureError?: NonNullable<DatabaseOperationWithLogBrewSpanOptions["onCaptureError"]>;
};

type LogBrewPrismaExtension = {
  readonly name: "logbrew";
  readonly query: {
    readonly $allOperations: <Result = unknown>(context: LogBrewPrismaOperationContext<Result>) => Promise<Awaited<Result>>;
  };
};

type LogBrewPrismaInstrumentation<Client> = {
  client: Client;
  isInstalled: () => boolean;
  uninstall: () => void;
};

declare function createLogBrewPrismaExtension(options: LogBrewPrismaSpanOptions): LogBrewPrismaExtension;

declare function instrumentLogBrewPrismaClient<Client extends { $extends: (extension: LogBrewPrismaExtension) => unknown }>(
  prismaClient: Client,
  options: LogBrewPrismaSpanOptions
): LogBrewPrismaInstrumentation<Client>;

declare function prismaOperationWithLogBrewSpan<Result = unknown>(
  context: LogBrewPrismaOperationContext<Result>,
  options: LogBrewPrismaSpanOptions
): Promise<Awaited<Result>>;

declare const defaultExport: {
  createLogBrewPrismaExtension: typeof createLogBrewPrismaExtension;
  instrumentLogBrewPrismaClient: typeof instrumentLogBrewPrismaClient;
  prismaOperationWithLogBrewSpan: typeof prismaOperationWithLogBrewSpan;
};

export type {
  LogBrewPrismaExtension,
  LogBrewPrismaInstrumentation,
  LogBrewPrismaOperationContext,
  LogBrewPrismaPrimitiveMetadata,
  LogBrewPrismaSpanOptions
};
export { createLogBrewPrismaExtension, instrumentLogBrewPrismaClient, prismaOperationWithLogBrewSpan };
export default defaultExport;
