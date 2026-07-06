import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createLogBrewPrismaExtension,
  instrumentLogBrewPrismaClient,
  prismaOperationWithLogBrewSpan
} = require("./index.cjs");

export {
  createLogBrewPrismaExtension,
  instrumentLogBrewPrismaClient,
  prismaOperationWithLogBrewSpan
};

export default {
  createLogBrewPrismaExtension,
  instrumentLogBrewPrismaClient,
  prismaOperationWithLogBrewSpan
};
