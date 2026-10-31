import prisma from "./index.cjs";

const { createLogBrewPrismaExtension, instrumentLogBrewPrismaClient, prismaOperationWithLogBrewSpan } = prisma;
const defaultExport = {
  createLogBrewPrismaExtension,
  instrumentLogBrewPrismaClient,
  prismaOperationWithLogBrewSpan
};

export { createLogBrewPrismaExtension, instrumentLogBrewPrismaClient, prismaOperationWithLogBrewSpan };
export default defaultExport;
