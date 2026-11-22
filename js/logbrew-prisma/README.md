# @logbrew/prisma

Prisma Client tracing helpers for Node.js services using the public LogBrew JavaScript SDK.

Install the core, Node, Prisma integration, and Prisma client packages:

```bash
npm install @logbrew/sdk @logbrew/node @logbrew/prisma @prisma/client
```

```bash
pnpm add @logbrew/sdk @logbrew/node @logbrew/prisma @prisma/client
```

The package supports Prisma ORM 7 and later. Prisma 7 connects through a driver adapter, so also install the adapter for your database, for example `@prisma/adapter-better-sqlite3` for SQLite. On Prisma 5 or 6, use `@logbrew/prisma@0.1.4`.

Use a project-scoped server ingest key, for example `LOGBREW_SERVER_API_KEY`.

```ts
import { createLogBrewNodeClient } from "@logbrew/node";
import { instrumentLogBrewPrismaClient } from "@logbrew/prisma";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client";

const logbrew = createLogBrewNodeClient({
  serverApiKey: process.env.LOGBREW_SERVER_API_KEY,
  sdkName: "checkout-api",
  sdkVersion: "1.0.0"
});

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: "file:./dev.db" }),
  log: ["info", "warn", "error"].map((level) => ({ emit: "event", level }))
});
const prismaTracing = instrumentLogBrewPrismaClient(prisma, {
  client: logbrew,
  databaseName: "app",
  metadata: {
    release: "checkout-api@1.0.0",
    service: "checkout-api"
  }
});

await prismaTracing.client.order.findMany();
```

Import `PrismaClient` from the `output` path of your `prisma-client` generator, or from `@prisma/client` if you use the `prisma-client-js` generator.

## What It Captures

`instrumentLogBrewPrismaClient()` returns an extended Prisma Client and a small handle with `isInstalled()` and `uninstall()`. It uses Prisma Client extensions, so LogBrew does not patch Prisma globally, replace the original client, create database connections, or own migrations.

Each Prisma operation creates one database span with:

- `traceId`, `spanId`, and optional parent span from the active LogBrew trace or an explicit `trace`.
- `prismaAction`, such as `findMany`, `create`, or `queryRaw`.
- `prismaModel` for model operations.
- `dbSystem: "prisma"`, operation kind, optional sanitized `databaseName`, duration, status, and array/number row count when available.
- Exception type only for failed operations.

Each operation also sends one `db.client.operation.duration` histogram in milliseconds and one breadcrumb. A failed operation sends one handled issue, such as `prisma create User failed`, with the error type and stack frames on the span's trace. The Prisma error message is not sent.

When the Prisma Client emits `info`, `warn`, or `error` log events (`log: [{ emit: "event", level: "warn" }]`), LogBrew sends each one as a LogBrew log on the active trace and as a breadcrumb. Prisma `query` events are not captured, so SQL text and parameters stay out of LogBrew.

## Privacy Defaults

LogBrew intentionally avoids Prisma engine internals and query payload capture. It does not record SQL text, Prisma `args`, result objects, database connection details, arbitrary headers, request/response bodies, exception messages, baggage, or tracestate. Issues from failed operations carry the exception type and stack frames.

Use `createLogBrewPrismaExtension()` when you want to attach the extension yourself:

```js
import { createLogBrewPrismaExtension } from "@logbrew/prisma";

const extension = createLogBrewPrismaExtension({ client: logbrew });
const prismaWithLogBrew = prisma.$extends(extension);
```

Use `prismaOperationWithLogBrewSpan()` for a single app-owned wrapper around a Prisma-like operation:

```js
import { prismaOperationWithLogBrewSpan } from "@logbrew/prisma";

await prismaOperationWithLogBrewSpan({
  model: "Order",
  operation: "findMany",
  query: () => prisma.order.findMany()
}, { client: logbrew });
```

## Tradeoff

Some tools use deeper Prisma runtime instrumentation to capture engine spans automatically. LogBrew starts with explicit, reversible Prisma Client extensions because that keeps setup simple, works from installed package artifacts, and avoids SQL or connection-detail capture by default.
