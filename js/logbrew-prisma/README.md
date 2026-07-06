# @logbrew/prisma

Prisma Client tracing helpers for Node.js services using the public LogBrew JavaScript SDK.

Install the core, Node, Prisma integration, and Prisma client packages:

```bash
npm install @logbrew/sdk @logbrew/node @logbrew/prisma @prisma/client
```

```bash
pnpm add @logbrew/sdk @logbrew/node @logbrew/prisma @prisma/client
```

Use a project-scoped server ingest key, for example `LOGBREW_SERVER_API_KEY`.

```js
import { PrismaClient } from "@prisma/client";
import { LogBrewClient } from "@logbrew/sdk";
import { instrumentLogBrewPrismaClient } from "@logbrew/prisma";

const logbrew = LogBrewClient.create({
  apiKey: process.env.LOGBREW_SERVER_API_KEY,
  sdkName: "checkout-api",
  sdkVersion: "1.0.0"
});

const prisma = new PrismaClient();
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

## What It Captures

`instrumentLogBrewPrismaClient()` returns an extended Prisma Client and a small handle with `isInstalled()` and `uninstall()`. It uses Prisma Client extensions, so LogBrew does not patch Prisma globally, replace the original client, create database connections, or own migrations.

Each Prisma operation creates one database span with:

- `traceId`, `spanId`, and optional parent span from the active LogBrew trace or an explicit `trace`.
- `prismaAction`, such as `findMany`, `create`, or `queryRaw`.
- `prismaModel` for model operations.
- `dbSystem: "prisma"`, operation kind, optional sanitized `databaseName`, duration, status, and array/number row count when available.
- Exception type only for failed operations.

## Privacy Defaults

LogBrew intentionally avoids Prisma engine internals and query payload capture. It does not record SQL text, Prisma `args`, result objects, database connection details, arbitrary headers, request/response bodies, exception messages, stacks, baggage, or tracestate.

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

Sentry and Datadog use deeper Prisma runtime instrumentation to capture engine spans automatically. LogBrew starts with explicit, reversible Prisma Client extensions because that keeps setup simple, works from installed package artifacts, and avoids SQL or connection-detail capture by default.
