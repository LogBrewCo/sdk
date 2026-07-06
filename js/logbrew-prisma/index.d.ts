import type { LogBrewClient, SpanEventSummary, SpanLinkSummary } from "@logbrew/sdk";
import type { LogBrewTraceContext } from "@logbrew/node";

export type LogBrewPrismaPrimitiveMetadata = Record<string, string | number | boolean | null>;

export type LogBrewPrismaOperationContext<Result = unknown> = {
  args?: unknown;
  model?: string;
  operation?: string;
  query: (args?: unknown) => Result | Promise<Result>;
};

export type LogBrewPrismaSpanOptions = {
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
  onCaptureError?: (
    error: unknown,
    context: {
      client: LogBrewClient;
      error?: unknown;
      trace: LogBrewTraceContext;
    }
  ) => void | Promise<void>;
};

export type LogBrewPrismaExtension = {
  name: "logbrew";
  query: {
    $allOperations<Result = unknown>(
      context: LogBrewPrismaOperationContext<Result>
    ): Promise<Awaited<Result>>;
  };
};

export type LogBrewPrismaInstrumentation<Client> = {
  client: Client;
  isInstalled(): boolean;
  uninstall(): void;
};

export declare function createLogBrewPrismaExtension(
  options: LogBrewPrismaSpanOptions
): LogBrewPrismaExtension;

export declare function instrumentLogBrewPrismaClient<
  Client extends { $extends(extension: LogBrewPrismaExtension): unknown }
>(
  prismaClient: Client,
  options: LogBrewPrismaSpanOptions
): LogBrewPrismaInstrumentation<Client>;

export declare function prismaOperationWithLogBrewSpan<Result = unknown>(
  context: LogBrewPrismaOperationContext<Result>,
  options: LogBrewPrismaSpanOptions
): Promise<Awaited<Result>>;

declare const defaultExport: {
  createLogBrewPrismaExtension: typeof createLogBrewPrismaExtension;
  instrumentLogBrewPrismaClient: typeof instrumentLogBrewPrismaClient;
  prismaOperationWithLogBrewSpan: typeof prismaOperationWithLogBrewSpan;
};

export default defaultExport;
