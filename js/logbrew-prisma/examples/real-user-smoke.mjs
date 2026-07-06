import { LogBrewClient } from "@logbrew/sdk";
import { createLogBrewPrismaExtension } from "@logbrew/prisma";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "prisma-real-user-smoke",
  sdkVersion: "0.1.0"
});

const extension = createLogBrewPrismaExtension({ client });
await extension.query.$allOperations({
  args: {},
  model: "User",
  operation: "findMany",
  query: async () => [{ id: 1 }]
});

console.log(client.previewJson());
