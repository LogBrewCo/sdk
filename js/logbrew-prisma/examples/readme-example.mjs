import { LogBrewClient } from "@logbrew/sdk";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { instrumentLogBrewPrismaClient } from "@logbrew/prisma";

const logbrew = LogBrewClient.create({
  apiKey: process.env["LOGBREW_SERVER_API_KEY"] ?? "LOGBREW_SERVER_API_KEY",
  sdkName: "checkout-api",
  sdkVersion: "1.0.0"
});

const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: "file:./dev.db" }) });
const prismaTracing = instrumentLogBrewPrismaClient(prisma, {
  client: logbrew,
  databaseName: "app",
  metadata: {
    release: "checkout-api@1.0.0",
    service: "checkout-api"
  }
});

await prismaTracing.client.order.findMany();
