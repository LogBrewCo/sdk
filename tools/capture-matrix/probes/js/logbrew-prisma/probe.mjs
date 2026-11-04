import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { createLogBrewNodeClient, createLogBrewTraceContext, runWithLogBrewTrace, setLogBrewUser } from "@logbrew/node";
import { instrumentLogBrewPrismaClient } from "@logbrew/prisma";

process.env.LOGBREW_RELEASE = "checkout@1.2.3";
process.env.LOGBREW_ENVIRONMENT = "production";
process.env.LOGBREW_SERVICE_NAME = "checkout-api";
process.env.CHECKPOINT_DISABLE = "1";
process.env.PRISMA_HIDE_UPDATE_MESSAGE = "1";
const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
const generate = spawnSync(process.execPath, [prismaCli, "generate", "--schema", "prisma/schema.prisma"], { stdio: "inherit" });
if (generate.status !== 0) {
  process.exit(generate.status ?? 1);
}
const database = new Database("checkout.db");
database.exec('DROP TABLE IF EXISTS "Order"; CREATE TABLE "Order" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "cart" TEXT NOT NULL UNIQUE, "total" INTEGER NOT NULL)');
database.close();
const { PrismaClient } = await import("./generated/index.js");

const logbrew = createLogBrewNodeClient({ serverApiKey: "LOGBREW_SERVER_API_KEY", endpoint: process.env.LOGBREW_CAPTURE_ENDPOINT });
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: "file:./checkout.db" }), log: ["query", "info", "warn", "error"] });
const tracing = instrumentLogBrewPrismaClient(prisma, { client: logbrew, databaseName: "checkout" });

const trace = createLogBrewTraceContext("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
await runWithLogBrewTrace(trace, async () => {
  setLogBrewUser("user_123");
  await tracing.client.order.create({ data: { cart: "cart-1", total: 1200 } });
  await tracing.client.order.findMany();
  try {
    await tracing.client.order.create({ data: { cart: "cart-1", total: 900 } });
  } catch (error) {
    console.error("duplicate cart rejected", error.code);
  }
});
tracing.uninstall();
await prisma.$disconnect();
await logbrew.shutdown();
