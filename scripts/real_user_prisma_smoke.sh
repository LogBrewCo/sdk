#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
node_package_version="$(node -p "require('${repo_root}/js/logbrew-node/package.json').version")"
prisma_package_version="$(node -p "require('${repo_root}/js/logbrew-prisma/package.json').version")"
tmp_dir="$(mktemp -d)"
export npm_config_cache="$tmp_dir/npm-cache"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

core_pack_json="$tmp_dir/core-pack.json"
node_pack_json="$tmp_dir/node-pack.json"
prisma_pack_json="$tmp_dir/prisma-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-node" && npm pack --json --pack-destination "$tmp_dir") > "$node_pack_json"
(cd "$repo_root/js/logbrew-prisma" && npm pack --json --pack-destination "$tmp_dir") > "$prisma_pack_json"

package_tgz() {
  python3 - "$1" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
}

core_tgz="$tmp_dir/$(package_tgz "$core_pack_json")"
node_tgz="$tmp_dir/$(package_tgz "$node_pack_json")"
prisma_tgz="$tmp_dir/$(package_tgz "$prisma_pack_json")"
test -f "$core_tgz"
test -f "$node_tgz"
test -f "$prisma_tgz"

tar -tzf "$prisma_tgz" > "$tmp_dir/prisma-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/prisma-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/prisma-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/prisma-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/prisma-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/prisma-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/prisma-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/prisma-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/prisma-tarball.txt"
tar -xOf "$prisma_tgz" package/README.md > "$tmp_dir/prisma-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/node @logbrew/prisma @prisma/client' "$tmp_dir/prisma-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/node @logbrew/prisma @prisma/client' "$tmp_dir/prisma-readme.md"
grep -q 'LOGBREW_SERVER_API_KEY' "$tmp_dir/prisma-readme.md"
grep -q 'project-scoped server ingest key' "$tmp_dir/prisma-readme.md"
grep -q 'instrumentLogBrewPrismaClient' "$tmp_dir/prisma-readme.md"
grep -q 'createLogBrewPrismaExtension' "$tmp_dir/prisma-readme.md"

app_dir="$tmp_dir/prisma-smoke-app"
mkdir -p "$app_dir/prisma"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install \
  --save-exact \
  --no-audit \
  --fund=false \
  "$core_tgz" \
  "$node_tgz" \
  "$prisma_tgz" \
  @prisma/client@6.17.0 \
  prisma@6.17.0 \
  typescript@6.0.3 \
  @types/node@26.0.1 \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/node": "file:' package.json
grep -q '"@logbrew/prisma": "file:' package.json
grep -q '"@prisma/client": "6.17.0"' package.json
grep -q '"@logbrew/prisma"' package-lock.json
grep -q '"@logbrew/node"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/node @logbrew/prisma @prisma/client prisma >/dev/null
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/node@${node_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/prisma@${prisma_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q '@prisma/client@6.17.0' "$tmp_dir/npm-list-depth0.txt"
test -f node_modules/@logbrew/prisma/index.js
test -f node_modules/@logbrew/prisma/index.cjs
test -f node_modules/@logbrew/prisma/index.d.ts

cat > prisma/schema.prisma <<'EOF'
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String?
}
EOF

npx prisma generate --schema prisma/schema.prisma >/dev/null
node --no-warnings --input-type=module <<'EOF'
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("prisma/dev.db");
db.exec('CREATE TABLE IF NOT EXISTS "User" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "email" TEXT NOT NULL UNIQUE, "name" TEXT)');
db.close();
EOF

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "strict": true,
    "target": "ES2022",
    "types": ["node"]
  },
  "include": ["types.ts", "types.cts"]
}
EOF

cat > types.ts <<'EOF'
import { PrismaClient } from "@prisma/client";
import { LogBrewClient } from "@logbrew/sdk";
import {
  createLogBrewPrismaExtension,
  instrumentLogBrewPrismaClient,
  prismaOperationWithLogBrewSpan
} from "@logbrew/prisma";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "prisma-type-smoke",
  sdkVersion: "0.1.0"
});
const prisma = new PrismaClient();
const extension = createLogBrewPrismaExtension({ client });
const extended = prisma.$extends(extension);
const instrumentation = instrumentLogBrewPrismaClient(prisma, { client, databaseName: "app" });
const users = extended.user.findMany();
const created = instrumentation.client.user.create({
  data: { email: "typed@example.test" }
});
const direct = prismaOperationWithLogBrewSpan({
  args: {},
  model: "User",
  operation: "findMany",
  query: async () => []
}, { client });

void users;
void created;
void direct;
instrumentation.uninstall();
void instrumentation.isInstalled();
EOF

cat > types.cts <<'EOF'
import prismaTools, { createLogBrewPrismaExtension } from "@logbrew/prisma";
import { LogBrewClient } from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "prisma-cjs-type-smoke",
  sdkVersion: "0.1.0"
});
const extension = createLogBrewPrismaExtension({ client });
void extension;
void prismaTools.instrumentLogBrewPrismaClient;
EOF

npx tsc --noEmit

cat > cjs-smoke.cjs <<'EOF'
const logbrewPrisma = require("@logbrew/prisma");

if (typeof logbrewPrisma.instrumentLogBrewPrismaClient !== "function") {
  throw new Error("missing CommonJS Prisma instrumentation export");
}
if (typeof logbrewPrisma.createLogBrewPrismaExtension !== "function") {
  throw new Error("missing CommonJS Prisma extension export");
}
EOF

node cjs-smoke.cjs

cat > smoke.mjs <<'EOF'
import http from "node:http";
import { once } from "node:events";
import { PrismaClient } from "@prisma/client";
import { LogBrewClient } from "@logbrew/sdk";
import { createNodeFetchTransport } from "@logbrew/node";
import {
  createLogBrewPrismaExtension,
  instrumentLogBrewPrismaClient,
  prismaOperationWithLogBrewSpan
} from "@logbrew/prisma";

const serverApiKey = "LOGBREW_SERVER_API_KEY";
const trace = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  sampled: true
};
const drops = [];
let spanSequence = 0;
const client = LogBrewClient.create({
  apiKey: serverApiKey,
  maxQueueSize: 1000,
  maxRetries: 1,
  sdkName: "prisma-smoke-app",
  sdkVersion: "0.1.0",
  onEventDropped(drop) {
    drops.push(drop);
  }
});
const prisma = new PrismaClient();
const instrumentation = instrumentLogBrewPrismaClient(prisma, {
  client,
  databaseName: "app",
  metadata: {
    release: "checkout-api@1.2.3",
    service: "checkout-api",
    query: "SELECT * FROM User WHERE email = dev@example.test",
    headers: "must not leak",
    connectionString: "file:./dev.db"
  },
  now: () => "2026-06-02T10:00:06Z",
  nowMs: makeNowMs(),
  spanIdFactory() {
    spanSequence += 1;
    return hexId(spanSequence, 16);
  },
  trace
});

if (!instrumentation.isInstalled()) {
  throw new Error("expected Prisma instrumentation to report installed");
}
if (instrumentation.client === prisma) {
  throw new Error("expected Prisma instrumentation to return an extended client");
}

await instrumentation.client.user.create({
  data: {
    email: "dev@example.test",
    name: "Sensitive User"
  }
});
const users = await instrumentation.client.user.findMany({
  where: { email: "dev@example.test" }
});
if (users.length !== 1) {
  throw new Error(`expected one user, got ${users.length}`);
}
let duplicateError;
try {
  await instrumentation.client.user.create({
    data: {
      email: "dev@example.test",
      name: "Duplicate Sensitive User"
    }
  });
} catch (error) {
  duplicateError = error;
}
if (!duplicateError) {
  throw new Error("expected Prisma duplicate create to throw");
}

const extension = createLogBrewPrismaExtension({
  client,
  id: "evt_prisma_direct_001",
  now: () => "2026-06-02T10:00:08Z",
  spanIdFactory: () => "9999999999999999",
  trace
});
await extension.query.$allOperations({
  args: { where: { email: "dev@example.test" } },
  model: "User",
  operation: "findFirst",
  query: async () => ({ id: 1 })
});
await prismaOperationWithLogBrewSpan({
  args: { sql: "SELECT private" },
  model: undefined,
  operation: "$queryRaw",
  query: async () => 1
}, {
  client,
  id: "evt_prisma_raw_001",
  now: () => "2026-06-02T10:00:09Z",
  spanIdFactory: () => "aaaaaaaaaaaaaaaa",
  trace
});

const eventCountBeforeUninstall = client.pendingEvents();
instrumentation.uninstall();
if (instrumentation.isInstalled()) {
  throw new Error("expected Prisma instrumentation to report uninstalled");
}
await instrumentation.client.user.findMany();
if (client.pendingEvents() !== eventCountBeforeUninstall) {
  throw new Error("uninstalled Prisma client extension should not capture new spans");
}
await prisma.$disconnect();

const events = JSON.parse(client.previewJson()).events;
const createSpan = findEvent(events, (event) => event.attributes.metadata?.prismaAction === "create");
const findManySpan = findEvent(events, (event) => event.attributes.metadata?.prismaAction === "findMany");
const errorSpan = findEvent(events, (event) => event.attributes.status === "error");
const directSpan = findEvent(events, "evt_prisma_direct_001");
const rawSpan = findEvent(events, "evt_prisma_raw_001");

assertEqual(createSpan.attributes.name, "prisma create User", "create span name");
assertEqual(createSpan.attributes.traceId, trace.traceId, "create trace id");
assertEqual(createSpan.attributes.parentSpanId, trace.spanId, "create parent span");
assertEqual(createSpan.attributes.metadata.framework, "node:database", "framework");
assertEqual(createSpan.attributes.metadata.prismaAction, "create", "create action");
assertEqual(createSpan.attributes.metadata.prismaModel, "User", "model");
assertEqual(createSpan.attributes.metadata.dbSystem, "prisma", "db system");
assertEqual(createSpan.attributes.metadata.dbOperation, "User", "db operation");
assertEqual(createSpan.attributes.metadata.dbOperationKind, "create", "operation kind");
assertEqual(createSpan.attributes.metadata.dbStatementTemplate, "User.create", "statement template");
assertEqual(createSpan.attributes.metadata.dbName, "app", "db name");
assertEqual(createSpan.attributes.metadata.sampled, true, "sampled");
assertEqual(findManySpan.attributes.metadata.rowCount, 1, "findMany row count");
assertEqual(errorSpan.attributes.metadata.errorType, duplicateError.constructor.name, "error type");
assertEqual(errorSpan.attributes.events[0].metadata.exceptionType, duplicateError.constructor.name, "exception span event type");
assertEqual(directSpan.attributes.metadata.prismaAction, "findFirst", "direct action");
assertEqual(rawSpan.attributes.metadata.prismaAction, "queryRaw", "raw action");
assertEqual(rawSpan.attributes.metadata.prismaModel, undefined, "raw model omitted");

const preview = client.previewJson();
for (const forbidden of [
  "Sensitive User",
  "Duplicate Sensitive User",
  "dev@example.test",
  "SELECT *",
  "SELECT private",
  '"connectionString"',
  '"headers"',
  '"query"',
  "file:./dev.db",
  duplicateError.message,
  duplicateError.stack?.split("\n")[0]
].filter(Boolean)) {
  if (preview.includes(forbidden)) {
    throw new Error(`Prisma telemetry leaked forbidden detail: ${forbidden}`);
  }
}

const highLoadClient = LogBrewClient.create({
  apiKey: serverApiKey,
  maxQueueSize: 1000,
  maxRetries: 1,
  sdkName: "prisma-high-load-smoke",
  sdkVersion: "0.1.0",
  onEventDropped(drop) {
    drops.push(drop);
  }
});
const highLoadExtension = createLogBrewPrismaExtension({
  client: highLoadClient,
  trace,
  spanIdFactory: makeSequenceFactory("b"),
  nowMs: makeNowMs()
});
for (let index = 0; index < 1500; index += 1) {
  await highLoadExtension.query.$allOperations({
    args: { where: { email: `hidden-${index}@example.test` } },
    model: "User",
    operation: "findMany",
    query: async () => [{ id: index }]
  });
}
assertEqual(highLoadClient.pendingEvents(), 1000, "high-load bounded queue");
assertEqual(highLoadClient.droppedEvents(), 500, "high-load drop count");

const intakeRequests = [];
const intakeServer = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    intakeRequests.push({
      authorization: req.headers.authorization,
      body,
      contentType: req.headers["content-type"],
      method: req.method,
      url: req.url
    });
    res.statusCode = intakeRequests.length === 1 ? 503 : 202;
    res.end("accepted");
  });
});
intakeServer.listen(0, "127.0.0.1");
await once(intakeServer, "listening");
const intakePort = intakeServer.address().port;
const response = await highLoadClient.flush(createNodeFetchTransport({
  endpoint: `http://127.0.0.1:${intakePort}/v1/events`
}));
await closeServer(intakeServer);

assertEqual(response.statusCode, 202, "flush status");
assertEqual(response.batches, 10, "accepted batch count");
assertEqual(response.attempts, response.batches + 1, "retry attempts across batches");
assertEqual(intakeRequests.length, response.attempts, "request count");
assertEqual(highLoadClient.pendingEvents(), 0, "high-load queue after flush");
for (const request of intakeRequests) {
  assertEqual(request.authorization, `Bearer ${serverApiKey}`, "authorization header");
  assertEqual(request.contentType, "application/json", "content type");
  assertEqual(request.method, "POST", "request method");
  assertEqual(request.url, "/v1/events", "request path");
  for (const forbidden of ["hidden-1499@example.test", "SELECT", "connectionString", "headers", "query"]) {
    if (request.body.includes(forbidden)) {
      throw new Error(`high-load payload leaked forbidden detail: ${forbidden}`);
    }
  }
}
assertEqual(intakeRequests[0].body, intakeRequests[1].body, "stable retry body");
const acceptedPayloads = intakeRequests.slice(1).map((request) => JSON.parse(request.body));
assertEqual(acceptedPayloads.length, response.batches, "accepted payload count");
for (let index = 0; index < acceptedPayloads.length; index += 1) {
  if (acceptedPayloads[index].events.length > 100) {
    throw new Error(`batch ${index} exceeded event limit`);
  }
  if (Buffer.byteLength(intakeRequests[index + 1].body, "utf8") > 256 * 1024) {
    throw new Error(`batch ${index} exceeded byte limit`);
  }
}
const flushedEvents = acceptedPayloads.flatMap((payload) => payload.events);
assertEqual(flushedEvents.length, 1000, "flushed event count");
assertEqual(new Set(flushedEvents.map((event) => event.id)).size, 1000, "unique event count");

console.log(JSON.stringify({
  batches: response.batches,
  capturedEvents: events.length,
  droppedEvents: highLoadClient.droppedEvents(),
  flushedEvents: flushedEvents.length,
  ok: true,
  package: "@logbrew/prisma",
  retryAttempts: response.attempts
}));

function makeNowMs() {
  let current = 1000;
  return () => {
    current += 7;
    return current;
  };
}

function makeSequenceFactory(prefix) {
  let value = 0;
  return () => {
    value += 1;
    return `${prefix}${String(value).padStart(15, "0")}`.slice(0, 16);
  };
}

function hexId(value, width) {
  return value.toString(16).padStart(width, "0").slice(-width);
}

function findEvent(events, idOrPredicate) {
  const predicate = typeof idOrPredicate === "function"
    ? idOrPredicate
    : (event) => event.id === idOrPredicate;
  const event = events.find(predicate);
  if (!event) {
    throw new Error(`missing event ${idOrPredicate}`);
  }
  return event;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
EOF

node smoke.mjs
