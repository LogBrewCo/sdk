import { PrismaClient } from "@prisma/client";
import { LogBrewClient } from "@logbrew/sdk";
import { instrumentLogBrewPrismaClient } from "@logbrew/prisma";

const client = LogBrewClient.create({
  apiKey: process.env.LOGBREW_SERVER_API_KEY ?? "LOGBREW_SERVER_API_KEY",
  sdkName: "prisma-example",
  sdkVersion: "0.1.0"
});

const prisma = new PrismaClient();
const instrumentation = instrumentLogBrewPrismaClient(prisma, {
  client,
  databaseName: "app",
  metadata: {
    release: "prisma-example@0.1.0",
    service: "prisma-example"
  }
});

await instrumentation.client.$connect?.();
console.log("LogBrew Prisma tracing is ready");
instrumentation.uninstall();
await prisma.$disconnect?.();
